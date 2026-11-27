BEGIN;

-- 0678 HQ Creative: the flyer, poster and social design editor for HON's own marketing (coordinator-allocated 2026-11-24;
-- docs/architecture/HQ_CREATIVE_DESIGNS.md). Owner decision (David, 2026-11-24 08:50Z, card "Bring the free flyer and
-- poster editor to HQ Creative now?"): "Yes, add the editor to HQ".
--   HD1  The same document, sizes, names and photo rules as the school editor (0617): hon.creative_design_document_ok,
--        hon.creative_design_name_ok, hon.creative_design_size and hon.paper_import_image_clean are reused unchanged.
--   HD2  HQ-native tables with no organization or school: HQ designs are never a school's and a school design is never
--        HQ's. Every photo an HQ document places must be an HQ design photo.
--   HD3  Who: the HQ people of 0252 (hon.require_hq_marketing_actor). Read = hq.marketing.read or manage; change = the HQ
--        owner or hq.marketing.manage. The actor is proved again before returning. No school role reaches these tables.
--   HD4  Designs are never deleted; each change is the next version under the exact expected version; archive and restore
--        are their own command; an archived design must be restored before it changes. Every command is idempotent per
--        actor and key (exact replay, key reuse refused) and keeps its receipt. At most 200 active and 1,000 designs,
--        300 photos and 150,000,000 photo bytes in all.
--   HD5  Forced RLS with no policies; the runtime gains only EXECUTE on six entry points.
-- Nothing here sends, publishes, prints, charges, spends credits or calls an AI or any other outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.require_hq_marketing_actor(text,boolean)') IS NULL OR to_regprocedure('hon.hq_marketing_person_json(uuid)') IS NULL
    OR to_regprocedure('hon.creative_design_document_ok(jsonb,text)') IS NULL OR to_regprocedure('hon.creative_design_name_ok(text)') IS NULL
    OR to_regprocedure('hon.creative_design_size(text)') IS NULL OR to_regprocedure('hon.paper_import_image_clean(text,bytea)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL OR to_regprocedure('hon.saas_fingerprint(text[])') IS NULL THEN
    RAISE EXCEPTION '0678 requires 0252 and 0617'; END IF;
END $$;

CREATE TABLE hon.hq_creative_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  CONSTRAINT hq_creative_designs_document CHECK (hon.creative_design_document_ok(document,size_code)),
  CHECK ((status='ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX hq_creative_designs_active_name ON hon.hq_creative_designs(lower(name)) WHERE status='ACTIVE';
CREATE INDEX hq_creative_designs_status_idx ON hon.hq_creative_designs(status,updated_at DESC);
ALTER TABLE hon.hq_creative_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_creative_designs FORCE ROW LEVEL SECURITY;

CREATE TABLE hon.hq_creative_design_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1400000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hq_creative_design_photos_clean CHECK (hon.paper_import_image_clean(media_type,content)),
  CONSTRAINT hq_creative_design_photos_checksum CHECK (checksum=encode(sha256(content),'hex'))
);
ALTER TABLE hon.hq_creative_design_photos ALTER COLUMN content SET STORAGE EXTERNAL;
ALTER TABLE hon.hq_creative_design_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_creative_design_photos FORCE ROW LEVEL SECURITY;

-- HD4 one row per HQ command key: the exact receipt a replay returns.
CREATE TABLE hon.hq_creative_design_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('SAVE','STATUS','PHOTO')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_principal_id,idempotency_key)
);
ALTER TABLE hon.hq_creative_design_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_creative_design_requests FORCE ROW LEVEL SECURITY;
-- No policies on any table: reachable only through the fixed definer functions below.

-- HD4 designs are never deleted; size, creator and creation time never change; every update is the next version.
CREATE FUNCTION hon.guard_hq_creative_design() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'CREATIVE_DESIGN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'ACTIVE' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.size_code,NEW.created_by_principal_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.size_code,OLD.created_by_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'CREATIVE_DESIGN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.hq_creative_designs FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_design();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_designs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_design();
-- Photos and receipts are insert-only.
CREATE FUNCTION hon.guard_hq_creative_design_append() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.hq_creative_design_photos FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_design_append();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_design_photos FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_design_append();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.hq_creative_design_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_creative_design_append();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_creative_design_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_creative_design_append();

-- The same JSON as 0617 (so one contract verifies both), without any organization or school.
CREATE FUNCTION hon.hq_creative_design_summary(d hon.hq_creative_designs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('designId',d.id,'name',d.name,'sizeCode',d.size_code,'status',d.status,'version',d.version,
    'createdAt',hon.saas_ts(d.created_at),'updatedAt',hon.saas_ts(d.updated_at))
$$;
CREATE FUNCTION hon.hq_creative_design_json(d hon.hq_creative_designs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.hq_creative_design_summary(d)||jsonb_build_object('document',d.document)
$$;
CREATE FUNCTION hon.hq_creative_design_photo_json(p hon.hq_creative_design_photos) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('photoId',p.id,'mediaType',p.media_type,'bytes',octet_length(p.content),'checksum',p.checksum,'createdAt',hon.saas_ts(p.created_at))
$$;

-- HD4 command start: one HQ design command at a time (so the name and count checks cannot race), then the exact replay.
CREATE FUNCTION hon.hq_creative_design_claim(p_actor uuid,p_key uuid,p_operation text,p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.hq_creative_design_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.hq_creative_designs',0));
  SELECT * INTO prior FROM hon.hq_creative_design_requests WHERE actor_principal_id=p_actor AND idempotency_key=p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation<>p_operation OR prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN prior.response||jsonb_build_object('replayed',true);
END $$;

-- Name free and caps respected for an active design (p_self excluded).
CREATE FUNCTION hon.hq_creative_design_room_check(p_name text,p_self uuid,p_new boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM hon.hq_creative_designs d WHERE d.status='ACTIVE' AND lower(d.name)=lower(p_name) AND d.id IS DISTINCT FROM p_self) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_NAME_TAKEN' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM hon.hq_creative_designs d WHERE d.status='ACTIVE' AND d.id IS DISTINCT FROM p_self)>=200
    OR (p_new AND (SELECT count(*) FROM hon.hq_creative_designs)>=1000) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_LIMIT' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION hon.hq_creative_design_id(p jsonb,p_key text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF jsonb_typeof(p->p_key) IS DISTINCT FROM 'string' OR p->>p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  RETURN (p->>p_key)::uuid;
END $$;

-- HQ designs, newest change first, without documents. p: {} or {status: ACTIVE|ARCHIVED}.
CREATE FUNCTION hon.read_hq_creative_designs(p_subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_status text; result jsonb;
BEGIN
  actor:=hon.require_hq_marketing_actor(p_subject,false);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'status')
    OR (p ? 'status' AND (jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ACTIVE','ARCHIVED'))) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  v_status:=coalesce(p->>'status','ACTIVE');
  SELECT jsonb_build_object('designs',coalesce(jsonb_agg(hon.hq_creative_design_summary(d) ORDER BY d.updated_at DESC,d.id),'[]'::jsonb)) INTO result
    FROM (SELECT * FROM hon.hq_creative_designs d WHERE d.status=v_status ORDER BY d.updated_at DESC,d.id LIMIT 1000) d;
  IF hon.require_hq_marketing_actor(p_subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- One HQ design with its document. p: {designId}.
CREATE FUNCTION hon.read_hq_creative_design(p_subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; d hon.hq_creative_designs%ROWTYPE;
BEGIN
  actor:=hon.require_hq_marketing_actor(p_subject,false);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['designId'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO d FROM hon.hq_creative_designs x WHERE x.id=hon.hq_creative_design_id(p,'designId');
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF hon.require_hq_marketing_actor(p_subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.hq_creative_design_json(d);
END $$;

-- One HQ photo with its bytes (base64). p: {photoId}.
CREATE FUNCTION hon.read_hq_creative_design_photo(p_subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; x hon.hq_creative_design_photos%ROWTYPE;
BEGIN
  actor:=hon.require_hq_marketing_actor(p_subject,false);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['photoId'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO x FROM hon.hq_creative_design_photos f WHERE f.id=hon.hq_creative_design_id(p,'photoId');
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF hon.require_hq_marketing_actor(p_subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.hq_creative_design_photo_json(x)||jsonb_build_object('data',translate(encode(x.content,'base64'),E'\n',''));
END $$;

-- Create or change one HQ design. p (all keys): {designId|null, expectedVersion, name, sizeCode, document}. A new design has
-- designId null and expectedVersion 0. A change keeps the size and needs an active design.
CREATE FUNCTION hon.save_hq_creative_design(p_subject text,p jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; fp text; d hon.hq_creative_designs%ROWTYPE; expected integer; result jsonb;
BEGIN
  actor:=hon.require_hq_marketing_actor(p_subject,true);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['designId','document','expectedVersion','name','sizeCode']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'designId')='null' OR (jsonb_typeof(p->'designId')='string' AND p->>'designId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR NOT hon.creative_design_name_ok(p->>'name')
    OR jsonb_typeof(p->'sizeCode') IS DISTINCT FROM 'string' OR NOT hon.creative_design_document_ok(p->'document',p->>'sizeCode')
    OR (jsonb_typeof(p->'designId')='null') <> ((p->>'expectedVersion')::integer=0) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer;
  fp:=hon.saas_fingerprint(ARRAY['hq.creative.design.save',p::text]);
  replay:=hon.hq_creative_design_claim(actor,p_key,'SAVE',fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject,true); RETURN replay; END IF;
  -- HD2 every placed photo is an HQ photo.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'document'->'pages') pg, jsonb_array_elements(pg->'elements') e
      WHERE e->>'kind'='image' AND NOT EXISTS(SELECT 1 FROM hon.hq_creative_design_photos f WHERE f.id=(e->>'imageId')::uuid)) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF jsonb_typeof(p->'designId')='string' THEN
    SELECT * INTO d FROM hon.hq_creative_designs x WHERE x.id=(p->>'designId')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF d.size_code<>p->>'sizeCode' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    IF d.version<>expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF d.status='ARCHIVED' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_ARCHIVED' USING ERRCODE='23514'; END IF;
  END IF;
  PERFORM hon.hq_creative_design_room_check(p->>'name',d.id,d.id IS NULL);
  IF d.id IS NULL THEN
    INSERT INTO hon.hq_creative_designs(name,size_code,document,status,created_by_principal_id,updated_by_principal_id)
      VALUES(p->>'name',p->>'sizeCode',p->'document','ACTIVE',actor,actor) RETURNING * INTO d;
  ELSE
    UPDATE hon.hq_creative_designs SET name=p->>'name',document=p->'document',version=d.version+1,
        updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
  END IF;
  result:=jsonb_build_object('design',hon.hq_creative_design_json(d));
  INSERT INTO hon.hq_creative_design_requests(actor_principal_id,idempotency_key,operation,fingerprint,response) VALUES(actor,p_key,'SAVE',fp,result);
  PERFORM hon.require_hq_marketing_actor(p_subject,true);
  RETURN result||jsonb_build_object('replayed',false);
END $$;

-- Archive or restore one HQ design. p (all keys): {designId, expectedVersion, status ARCHIVED|ACTIVE}.
CREATE FUNCTION hon.set_hq_creative_design_status(p_subject text,p jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; fp text; d hon.hq_creative_designs%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_hq_marketing_actor(p_subject,true);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['designId','expectedVersion','status']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ACTIVE','ARCHIVED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM hon.hq_creative_design_id(p,'designId');
  fp:=hon.saas_fingerprint(ARRAY['hq.creative.design.status',p::text]);
  replay:=hon.hq_creative_design_claim(actor,p_key,'STATUS',fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject,true); RETURN replay; END IF;
  SELECT * INTO d FROM hon.hq_creative_designs x WHERE x.id=(p->>'designId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREATIVE_DESIGN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF d.status=p->>'status' THEN RAISE EXCEPTION 'CREATIVE_DESIGN_STATUS_UNCHANGED' USING ERRCODE='23514'; END IF;
  IF p->>'status'='ACTIVE' THEN PERFORM hon.hq_creative_design_room_check(d.name,d.id,false); END IF;
  UPDATE hon.hq_creative_designs SET status=p->>'status',archived_at=CASE WHEN p->>'status'='ARCHIVED' THEN clock_timestamp() END,
      version=d.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
  result:=jsonb_build_object('design',hon.hq_creative_design_json(d));
  INSERT INTO hon.hq_creative_design_requests(actor_principal_id,idempotency_key,operation,fingerprint,response) VALUES(actor,p_key,'STATUS',fp,result);
  PERFORM hon.require_hq_marketing_actor(p_subject,true);
  RETURN result||jsonb_build_object('replayed',false);
END $$;

-- Upload one HQ photo. p (all keys): {mediaType, data} where data is canonical base64 of the already metadata-free bytes.
CREATE FUNCTION hon.add_hq_creative_design_photo(p_subject text,p jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; fp text; bytes bytea; x hon.hq_creative_design_photos%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_hq_marketing_actor(p_subject,true);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['data','mediaType']
    OR jsonb_typeof(p->'mediaType') IS DISTINCT FROM 'string' OR p->>'mediaType' NOT IN ('image/jpeg','image/png','image/webp')
    OR jsonb_typeof(p->'data') IS DISTINCT FROM 'string' OR length(p->>'data') NOT BETWEEN 4 AND 1866668
    OR p->>'data' !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  bytes:=decode(p->>'data','base64');
  IF octet_length(bytes) NOT BETWEEN 1 AND 1400000 OR NOT hon.paper_import_image_clean(p->>'mediaType',bytes) THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_REFUSED' USING ERRCODE='23514'; END IF;
  fp:=hon.saas_fingerprint(ARRAY['hq.creative.design.photo',encode(sha256(convert_to(p::text,'UTF8')),'hex')]);
  replay:=hon.hq_creative_design_claim(actor,p_key,'PHOTO',fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_marketing_actor(p_subject,true); RETURN replay; END IF;
  IF (SELECT count(*) FROM hon.hq_creative_design_photos)>=300
    OR (SELECT coalesce(sum(octet_length(f.content)),0) FROM hon.hq_creative_design_photos f)+octet_length(bytes)>150000000 THEN
    RAISE EXCEPTION 'CREATIVE_DESIGN_PHOTO_LIMIT' USING ERRCODE='23514'; END IF;
  INSERT INTO hon.hq_creative_design_photos(media_type,content,checksum,created_by_principal_id)
    VALUES(p->>'mediaType',bytes,encode(sha256(bytes),'hex'),actor) RETURNING * INTO x;
  result:=jsonb_build_object('photo',hon.hq_creative_design_photo_json(x));
  INSERT INTO hon.hq_creative_design_requests(actor_principal_id,idempotency_key,operation,fingerprint,response) VALUES(actor,p_key,'PHOTO',fp,result);
  PERFORM hon.require_hq_marketing_actor(p_subject,true);
  RETURN result||jsonb_build_object('replayed',false);
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_hq_creative_designs(text,jsonb)','hon.read_hq_creative_design(text,jsonb)','hon.read_hq_creative_design_photo(text,jsonb)',
    'hon.save_hq_creative_design(text,jsonb,uuid)','hon.set_hq_creative_design_status(text,jsonb,uuid)','hon.add_hq_creative_design_photo(text,jsonb,uuid)'];
  helpers text[]:=ARRAY['hon.guard_hq_creative_design()','hon.guard_hq_creative_design_append()','hon.hq_creative_design_summary(hon.hq_creative_designs)',
    'hon.hq_creative_design_json(hon.hq_creative_designs)','hon.hq_creative_design_photo_json(hon.hq_creative_design_photos)',
    'hon.hq_creative_design_claim(uuid,uuid,text,text)','hon.hq_creative_design_room_check(text,uuid,boolean)','hon.hq_creative_design_id(jsonb,text)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['hon.hq_creative_designs','hon.hq_creative_design_photos','hon.hq_creative_design_requests'] LOOP
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
