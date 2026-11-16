BEGIN;

-- Contact photos (0390, coordinator-allocated 2026-11-16): staff take or upload one photo of a person on the People
-- contact card, so attendance cards (0391) and the front-desk scan screen can show who is checking in.
--
-- * One current photo per person, private to that person's school. Forced RLS with no policy and no client table
--   privilege: the runtime role executes three fixed functions only.
-- * The API removes image metadata (EXIF/XMP/IPTC location and camera data, comments, text chunks) with the 0388
--   stripper; the table itself refuses any image that still carries it (hon.paper_import_image_clean, 0388).
-- * Seeing a photo needs people.read at that school; setting or removing one needs people.read + people.update
--   (the 0217 person actor: one active human principal, active school and organization, paid access).
-- * Remove is a hard delete of the bytes. Audit and outbox carry the person id, version and checksum only, never an
--   image, so a later consumer (face check-in) can react to people.photo.set / people.photo.removed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.school_person_actor(text,uuid,boolean)') IS NULL OR to_regprocedure('hon.paper_import_image_clean(text,bytea)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL THEN
    RAISE EXCEPTION '0390 requires 0217, 0388 and the saas timestamp helper'; END IF;
END $$;

CREATE TABLE hon.person_photos (
  person_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 400000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id),
  CONSTRAINT person_photos_clean CHECK (hon.paper_import_image_clean(media_type,content)),
  CONSTRAINT person_photos_checksum CHECK (checksum=encode(sha256(content),'hex'))
);
ALTER TABLE hon.person_photos ALTER COLUMN content SET STORAGE EXTERNAL;
CREATE INDEX person_photos_scope_idx ON hon.person_photos(organization_id,school_id);

CREATE TABLE hon.person_photo_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  operation text NOT NULL CHECK (operation IN ('set','remove')),
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,operation,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

ALTER TABLE hon.person_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.person_photos FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.person_photo_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.person_photo_requests FORCE ROW LEVEL SECURITY;

-- Evidence guard (settings-free). A photo keeps its person, school, organization and creator; every replacement
-- advances the version by one. A request records its response once and is never deleted. Neither table is truncated.
CREATE FUNCTION hon.guard_person_photo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'PERSON_PHOTO_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='person_photo_requests' THEN
    IF TG_OP='DELETE' OR OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
      OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.operation,NEW.idempotency_key,NEW.fingerprint,NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.operation,OLD.idempotency_key,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'PERSON_PHOTO_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.version<>OLD.version+1
    OR (NEW.person_id,NEW.organization_id,NEW.school_id,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.person_id,OLD.organization_id,OLD.school_id,OLD.created_by_principal_id,OLD.created_at) THEN
    RAISE EXCEPTION 'PERSON_PHOTO_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER person_photos_guard BEFORE UPDATE ON hon.person_photos FOR EACH ROW EXECUTE FUNCTION hon.guard_person_photo();
CREATE TRIGGER person_photo_requests_guard BEFORE UPDATE OR DELETE ON hon.person_photo_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_person_photo();
CREATE TRIGGER person_photos_no_truncate BEFORE TRUNCATE ON hon.person_photos FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_person_photo();
CREATE TRIGGER person_photo_requests_no_truncate BEFORE TRUNCATE ON hon.person_photo_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_person_photo();

-- The photo as staff see it, without the image.
CREATE FUNCTION hon.person_photo_summary(p hon.person_photos) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('personId',p.person_id,'mediaType',p.media_type,'bytes',octet_length(p.content),'checksum',p.checksum,
    'version',p.version,'updatedAt',hon.saas_ts(p.updated_at))
$$;

-- Read: {personId, photo: null | {mediaType, data, checksum, version, updatedAt}}. A person from another school or
-- organization is indistinguishable from a missing one.
CREATE FUNCTION hon.read_person_photo(p_subject text,p_school uuid,p_person uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid; ph hon.person_photos%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL OR p_person IS NULL THEN RAISE EXCEPTION 'PERSON_PHOTO_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.school_person_actor(p_subject,p_school,false) IS NULL THEN RAISE EXCEPTION 'PERSON_PHOTO_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  PERFORM 1 FROM hon.people WHERE id=p_person AND organization_id=v_org AND school_id=p_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_PHOTO_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO ph FROM hon.person_photos WHERE person_id=p_person AND organization_id=v_org AND school_id=p_school;
  IF NOT FOUND THEN RETURN jsonb_build_object('personId',p_person,'photo',NULL); END IF;
  RETURN jsonb_build_object('personId',p_person,'photo',jsonb_build_object('mediaType',ph.media_type,
    'data',translate(encode(ph.content,'base64'),E'\n',''),'checksum',ph.checksum,'version',ph.version,'updatedAt',hon.saas_ts(ph.updated_at)));
END $$;

-- Common prologue: closed input, live people.update authority, own receipt (exact replay only while authority is
-- current), then the person's photo row is serialized.
CREATE FUNCTION hon.person_photo_begin(p_subject text,p_operation text,p_input jsonb,p_key uuid,OUT actor uuid,OUT org uuid,OUT school uuid,OUT person uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE fp text; prior hon.person_photo_requests%ROWTYPE; uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_subject IS NULL OR p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_operation NOT IN ('set','remove')
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ uuid_re
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR p_input->>'personId' !~ uuid_re THEN
    RAISE EXCEPTION 'PERSON_PHOTO_INVALID' USING ERRCODE='22023'; END IF;
  school:=(p_input->>'schoolId')::uuid; person:=(p_input->>'personId')::uuid;
  actor:=hon.school_person_actor(p_subject,school,true);
  IF actor IS NULL THEN RAISE EXCEPTION 'PERSON_PHOTO_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM hon.schools WHERE id=school;
  fp:=encode(sha256(convert_to('PERSON_PHOTO:'||p_operation||':'||p_input::text,'UTF8')),'hex');
  INSERT INTO hon.person_photo_requests(organization_id,school_id,principal_id,operation,idempotency_key,fingerprint)
    VALUES(org,school,actor,p_operation,p_key,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.person_photo_requests WHERE organization_id=org AND school_id=school AND principal_id=actor
      AND operation=p_operation AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'PERSON_PHOTO_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'PERSON_PHOTO_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.school_person_actor(p_subject,school,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PERSON_PHOTO_FORBIDDEN' USING ERRCODE='42501'; END IF;
    replay:=prior.response; RETURN;
  END IF;
  -- The person must be at this exact school; KEY SHARE never blocks a person edit (NO KEY UPDATE).
  PERFORM 1 FROM hon.people WHERE id=person AND organization_id=org AND school_id=school FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_PHOTO_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Serializes concurrent first photos of one person (there is no row to lock yet).
  PERFORM pg_advisory_xact_lock(hashtextextended('person-photo:'||person::text,0));
END $$;

-- Common epilogue: identifier-only audit and outbox, receipt completion, authority decided again after the last write.
CREATE FUNCTION hon.person_photo_finish(p_subject text,p_actor uuid,p_org uuid,p_school uuid,p_person uuid,p_operation text,p_key uuid,
  p_prior jsonb,p_next jsonb,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_request uuid:=gen_random_uuid(); payload jsonb;
BEGIN
  payload:=jsonb_build_object('personId',p_person,'checksum',coalesce(p_next->>'checksum',p_prior->>'checksum'),
    'version',coalesce((p_next->>'version')::integer,(p_prior->>'version')::integer));
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(p_org,p_school,p_actor,'HUMAN_UI','people.photo.'||p_operation,'PERSON',p_person,p_prior,p_next,'SUCCEEDED',v_request,v_request,clock_timestamp());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),p_org,p_school,CASE p_operation WHEN 'set' THEN 'people.photo.set' ELSE 'people.photo.removed' END,1,'PERSON',p_person,
      (payload->>'version')::integer,v_request,v_request,payload);
  UPDATE hon.person_photo_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND operation=p_operation AND idempotency_key=p_key;
  IF hon.school_person_actor(p_subject,p_school,true) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'PERSON_PHOTO_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN p_result;
END $$;

-- Input: exactly {schoolId, personId, expectedVersion (null when the person has no photo), mediaType, data} with data
-- the base64 of an already metadata-free image of at most 400000 bytes. Returns {photo: summary, replaced}.
CREATE FUNCTION hon.set_person_photo(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; cur hon.person_photos%ROWTYPE; nxt hon.person_photos%ROWTYPE; bytes bytea; prior jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['data','expectedVersion','mediaType','personId','schoolId']
    OR jsonb_typeof(p_input->'expectedVersion') NOT IN ('number','null')
    OR (jsonb_typeof(p_input->'expectedVersion')='number' AND p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$')
    OR jsonb_typeof(p_input->'mediaType') IS DISTINCT FROM 'string' OR p_input->>'mediaType' NOT IN ('image/jpeg','image/png','image/webp')
    OR jsonb_typeof(p_input->'data') IS DISTINCT FROM 'string' OR length(p_input->>'data') NOT BETWEEN 4 AND 533336
    OR length(p_input->>'data')%4<>0 OR (p_input->>'data') !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
    RAISE EXCEPTION 'PERSON_PHOTO_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.person_photo_begin(p_subject,'set',p_input,p_key);
  IF s.replay IS NOT NULL THEN RETURN s.replay || jsonb_build_object('replayed',true); END IF;
  bytes:=decode(p_input->>'data','base64');
  IF octet_length(bytes) NOT BETWEEN 1 AND 400000 OR NOT hon.paper_import_image_clean(p_input->>'mediaType',bytes) THEN
    RAISE EXCEPTION 'PERSON_PHOTO_IMAGE_REFUSED' USING ERRCODE='22023'; END IF;
  SELECT * INTO cur FROM hon.person_photos WHERE person_id=s.person FOR UPDATE;
  IF cur.person_id IS NULL THEN
    IF jsonb_typeof(p_input->'expectedVersion')<>'null' THEN RAISE EXCEPTION 'PERSON_PHOTO_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.person_photos(person_id,organization_id,school_id,media_type,content,checksum,created_by_principal_id,updated_by_principal_id)
      VALUES(s.person,s.org,s.school,p_input->>'mediaType',bytes,encode(sha256(bytes),'hex'),s.actor,s.actor) RETURNING * INTO nxt;
  ELSE
    IF jsonb_typeof(p_input->'expectedVersion')<>'number' OR cur.version<>(p_input->>'expectedVersion')::integer THEN
      RAISE EXCEPTION 'PERSON_PHOTO_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    prior:=hon.person_photo_summary(cur);
    UPDATE hon.person_photos SET media_type=p_input->>'mediaType',content=bytes,checksum=encode(sha256(bytes),'hex'),version=version+1,
      updated_by_principal_id=s.actor,updated_at=clock_timestamp() WHERE person_id=s.person RETURNING * INTO nxt;
  END IF;
  RETURN hon.person_photo_finish(p_subject,s.actor,s.org,s.school,s.person,'set',p_key,prior,hon.person_photo_summary(nxt),
    jsonb_build_object('photo',hon.person_photo_summary(nxt),'replaced',prior IS NOT NULL,'replayed',false));
END $$;

-- Input: exactly {schoolId, personId, expectedVersion}. Deletes the photo bytes. Returns {personId, removed: true}.
CREATE FUNCTION hon.remove_person_photo(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; cur hon.person_photos%ROWTYPE;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','personId','schoolId']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'PERSON_PHOTO_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.person_photo_begin(p_subject,'remove',p_input,p_key);
  IF s.replay IS NOT NULL THEN RETURN s.replay || jsonb_build_object('replayed',true); END IF;
  SELECT * INTO cur FROM hon.person_photos WHERE person_id=s.person FOR UPDATE;
  IF cur.person_id IS NULL OR cur.version<>(p_input->>'expectedVersion')::integer THEN
    RAISE EXCEPTION 'PERSON_PHOTO_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  DELETE FROM hon.person_photos WHERE person_id=s.person;
  RETURN hon.person_photo_finish(p_subject,s.actor,s.org,s.school,s.person,'remove',p_key,hon.person_photo_summary(cur),NULL,
    jsonb_build_object('personId',s.person,'removed',true,'replayed',false));
END $$;

-- Deny first, then exactly the three entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['person_photos','person_photo_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_person_photo()','hon.person_photo_summary(hon.person_photos)','hon.read_person_photo(text,uuid,uuid)',
    'hon.person_photo_begin(text,text,jsonb,uuid)','hon.person_photo_finish(text,uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb,jsonb)',
    'hon.set_person_photo(text,jsonb,uuid)','hon.remove_person_photo(text,jsonb,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_person_photo(text,uuid,uuid),hon.set_person_photo(text,jsonb,uuid),hon.remove_person_photo(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
