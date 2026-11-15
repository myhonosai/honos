BEGIN;

-- Paper import (0388, coordinator-allocated 2026-11-15): a school without a spreadsheet photographs student cards or
-- attendance sheets, or scans contracts. HON reads the pages into a table with the columns of an existing import; staff
-- correct the table beside the photo, then send it to the existing staged import (0226 students and guardians, 0333
-- attendance history), where every row is decided before anything is saved. This migration stores pages and tables
-- only: it never creates a person, family, attendance record, membership, invoice, message or AI usage itself.
--
-- * Pages are private to one school, carry no image metadata (EXIF, XMP, IPTC, comments, PNG/WebP text chunks are
--   refused by structure), and are erased 30 days after upload or when staff delete them. The set row stays as the
--   audit record (who, when, checksums, which import batch it fed) with no image and no table.
-- * The only reader is SYNTHETIC (the stand-in). A real vision provider needs owner approval and a new migration with
--   cost reservation and usage records. Every reading still asks hon.ai_spend_allowed first, and a set is read once.
-- * Sending is done here, not by the client: the saved table becomes CSV text and goes through the existing stage
--   function in the same transaction, so the batch link cannot be forged and the existing imports are unchanged.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.require_student_import_actor(text)') IS NULL OR to_regprocedure('hon.stage_student_import(text,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.stage_history_import(text,jsonb,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.history_import_fields(text)') IS NULL
    OR to_regprocedure('hon.ai_spend_allowed(uuid,uuid,timestamp with time zone,text)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL THEN
    RAISE EXCEPTION '0388 requires 0226, 0333, 0353 and the saas timestamp helper'; END IF;
END $$;

CREATE TABLE hon.paper_import_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('STUDENT_CARDS','CONTRACTS','ATTENDANCE_SHEETS')),
  target text NOT NULL CHECK (target=CASE kind WHEN 'ATTENDANCE_SHEETS' THEN 'ATTENDANCE' ELSE 'STUDENTS' END),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','READ','SENT','DELETED')),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 10),
  page_checksums text[] NOT NULL DEFAULT '{}' CHECK (cardinality(page_checksums)=page_count),
  reading_id uuid, reading_started_at timestamptz,
  reader text CHECK (reader='SYNTHETIC'),
  read_outcome text CHECK (read_outcome IN ('SAMPLE_READ','NOT_READABLE')),
  read_at timestamptz,
  table_rows jsonb CHECK (table_rows IS NULL OR jsonb_typeof(table_rows)='array'),
  table_unsure jsonb CHECK (table_unsure IS NULL OR jsonb_typeof(table_unsure)='array'),
  sent_batch_id uuid, sent_row_count integer CHECK (sent_row_count BETWEEN 1 AND 200), sent_at timestamptz,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz, deleted_by_principal_id uuid REFERENCES hon.principals(id),
  delete_reason text CHECK (delete_reason IN ('STAFF','EXPIRED')),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  UNIQUE (id,organization_id,school_id),
  CHECK (expires_at=created_at+interval '30 days'),
  CHECK ((reading_id IS NULL)=(reading_started_at IS NULL)),
  CHECK ((reader IS NULL)=(read_at IS NULL) AND (reader IS NULL)=(read_outcome IS NULL) AND (reader IS NULL OR reading_id IS NOT NULL)),
  CHECK ((table_rows IS NULL)=(table_unsure IS NULL)),
  CHECK ((sent_at IS NULL)=(sent_batch_id IS NULL) AND (sent_at IS NULL)=(sent_row_count IS NULL)),
  CHECK ((deleted_at IS NULL)=(status<>'DELETED') AND (deleted_at IS NULL)=(delete_reason IS NULL)),
  CHECK (delete_reason IS DISTINCT FROM 'STAFF' OR deleted_by_principal_id IS NOT NULL),
  CHECK (delete_reason IS DISTINCT FROM 'EXPIRED' OR deleted_by_principal_id IS NULL),
  CHECK (status NOT IN ('READ','SENT') OR (read_at IS NOT NULL AND table_rows IS NOT NULL)),
  CHECK (status<>'SENT' OR sent_at IS NOT NULL),
  CHECK (status<>'OPEN' OR (read_at IS NULL AND table_rows IS NULL AND sent_at IS NULL)),
  CHECK (status<>'DELETED' OR table_rows IS NULL)
);
CREATE INDEX paper_import_sets_scope_idx ON hon.paper_import_sets(organization_id,school_id,created_at DESC,id);
CREATE INDEX paper_import_sets_expiry_idx ON hon.paper_import_sets(expires_at) WHERE status<>'DELETED';

CREATE TABLE hon.paper_import_pages (
  set_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  page_no integer NOT NULL CHECK (page_no BETWEEN 1 AND 10),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1400000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (set_id,page_no),
  UNIQUE (set_id,checksum),
  FOREIGN KEY (set_id,organization_id,school_id) REFERENCES hon.paper_import_sets(id,organization_id,school_id)
);
ALTER TABLE hon.paper_import_pages ALTER COLUMN content SET STORAGE EXTERNAL;

CREATE TABLE hon.paper_import_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('create','page','save','send','delete')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

ALTER TABLE hon.paper_import_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.paper_import_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.paper_import_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.paper_import_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.paper_import_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.paper_import_requests FORCE ROW LEVEL SECURITY;

-- Evidence guard (settings-free). Sets are never deleted; identity, kind, creator and expiry never change; every update
-- advances the version by one; DELETED is final; pages only grow while OPEN and their checksums are append-only; a
-- reading result, once recorded, belongs to that reading. Pages are never updated and are deleted only once their set is
-- DELETED (the erasure). A request records its response once.
CREATE FUNCTION hon.guard_paper_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE st text;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'PAPER_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='paper_import_requests' THEN
    IF TG_OP='DELETE' OR OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
      OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'PAPER_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='paper_import_pages' THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'PAPER_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
    SELECT s.status INTO st FROM hon.paper_import_sets s WHERE s.id=OLD.set_id;
    IF st IS DISTINCT FROM 'DELETED' THEN RAISE EXCEPTION 'PAPER_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='DELETE' OR OLD.status='DELETED' OR NEW.version<>OLD.version+1
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.kind,NEW.target,NEW.created_by_principal_id,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.kind,OLD.target,OLD.created_by_principal_id,OLD.created_at,OLD.expires_at)
    OR NEW.page_checksums[1:cardinality(OLD.page_checksums)] IS DISTINCT FROM OLD.page_checksums
    OR (NEW.page_count<>OLD.page_count AND (OLD.status<>'OPEN' OR NEW.status NOT IN ('OPEN','DELETED') OR NEW.page_count<OLD.page_count))
    OR (OLD.reader IS NOT NULL AND (NEW.reader,NEW.read_at,NEW.read_outcome,NEW.reading_id,NEW.reading_started_at)
      IS DISTINCT FROM (OLD.reader,OLD.read_at,OLD.read_outcome,OLD.reading_id,OLD.reading_started_at))
    OR (OLD.sent_at IS NOT NULL AND (NEW.sent_at,NEW.sent_batch_id,NEW.sent_row_count) IS DISTINCT FROM (OLD.sent_at,OLD.sent_batch_id,OLD.sent_row_count))
    OR NOT ((OLD.status=NEW.status AND NEW.status IN ('OPEN','READ')) OR (OLD.status,NEW.status) IN (('OPEN','READ'),('READ','SENT'))
      OR NEW.status='DELETED') THEN
    RAISE EXCEPTION 'PAPER_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paper_import_sets_guard BEFORE UPDATE OR DELETE ON hon.paper_import_sets FOR EACH ROW EXECUTE FUNCTION hon.guard_paper_import();
CREATE TRIGGER paper_import_pages_guard BEFORE UPDATE OR DELETE ON hon.paper_import_pages FOR EACH ROW EXECUTE FUNCTION hon.guard_paper_import();
CREATE TRIGGER paper_import_requests_guard BEFORE UPDATE OR DELETE ON hon.paper_import_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_paper_import();
CREATE TRIGGER paper_import_sets_no_truncate BEFORE TRUNCATE ON hon.paper_import_sets FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_paper_import();
CREATE TRIGGER paper_import_pages_no_truncate BEFORE TRUNCATE ON hon.paper_import_pages FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_paper_import();
CREATE TRIGGER paper_import_requests_no_truncate BEFORE TRUNCATE ON hon.paper_import_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_paper_import();

CREATE FUNCTION hon.paper_import_columns(p_target text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE p_target WHEN 'STUDENTS' THEN hon.student_import_fields() WHEN 'ATTENDANCE' THEN hon.history_import_fields('ATTENDANCE') END
$$;

-- One line of plain text: at most 200 characters, trimmed, no control, bidi-override or zero-width characters.
CREATE FUNCTION hon.paper_import_cell_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(p)='string' AND length(p#>>'{}')<=200 AND btrim(p#>>'{}')=(p#>>'{}')
    AND (p#>>'{}') !~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿�]'
$$;

-- 0..200 rows of exactly one cell per column of the target, and an unsure matrix of the same shape.
CREATE FUNCTION hon.paper_import_table_ok(p_target text,p_rows jsonb,p_unsure jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE width integer:=cardinality(hon.paper_import_columns(p_target)); i integer;
BEGIN
  IF width IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_typeof(p_unsure) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_rows)>200 OR jsonb_array_length(p_unsure)<>jsonb_array_length(p_rows) THEN RETURN false; END IF;
  FOR i IN 0..jsonb_array_length(p_rows)-1 LOOP
    IF jsonb_typeof(p_rows->i)<>'array' OR jsonb_array_length(p_rows->i)<>width OR jsonb_typeof(p_unsure->i)<>'array' OR jsonb_array_length(p_unsure->i)<>width
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows->i) c WHERE NOT hon.paper_import_cell_ok(c))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_unsure->i) c WHERE jsonb_typeof(c)<>'boolean') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

-- Structural image check. The bytes must be a well-formed JPEG, PNG or WebP of the declared type that carries no
-- metadata the API should have removed: JPEG APP1 (EXIF/XMP), APP13 (IPTC) and COM segments; PNG tEXt, zTXt, iTXt and
-- eXIf chunks; WebP EXIF and XMP chunks.
CREATE FUNCTION hon.paper_import_image_clean(p_type text,p bytea) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n integer:=octet_length(p); pos integer; m integer; len bigint; typ text; seen_ihdr boolean:=false; seen_image boolean:=false;
BEGIN
  IF p IS NULL OR n<12 THEN RETURN false; END IF;
  IF p_type='image/jpeg' THEN
    IF get_byte(p,0)<>255 OR get_byte(p,1)<>216 THEN RETURN false; END IF;
    pos:=2;
    LOOP
      IF pos+4>n OR get_byte(p,pos)<>255 THEN RETURN false; END IF;
      m:=get_byte(p,pos+1);
      IF m=255 THEN pos:=pos+1; CONTINUE; END IF;
      IF m BETWEEN 208 AND 215 OR m=1 THEN pos:=pos+2; CONTINUE; END IF;
      -- Only JFIF (APP0), an ICC profile (APP2) and Adobe (APP14) may stay; every other APPn and COM can carry metadata.
      IF m=254 OR (m BETWEEN 224 AND 239 AND m NOT IN (224,226,238)) THEN RETURN false; END IF;
      IF m=226 AND (pos+16>n OR substring(p FROM pos+5 FOR 12)<>'\x4943435f50524f46494c4500'::bytea) THEN RETURN false; END IF;
      IF m=217 THEN RETURN false; END IF;
      len:=get_byte(p,pos+2)*256+get_byte(p,pos+3);
      IF len<2 OR pos+2+len>n THEN RETURN false; END IF;
      IF m=218 THEN
        -- After the first scan only scan data, restarts and table segments follow: no APPn or COM marker may appear
        -- anywhere (entropy data never holds 0xFF before 0xE0..0xEF or 0xFE).
        FOR m IN 224..239 LOOP
          IF position(set_byte('\xff00'::bytea,1,m) IN substring(p FROM pos+3)) > 0 THEN RETURN false; END IF;
        END LOOP;
        IF position('\xfffe'::bytea IN substring(p FROM pos+3)) > 0 THEN RETURN false; END IF;
        RETURN get_byte(p,n-2)=255 AND get_byte(p,n-1)=217;
      END IF;
      pos:=pos+2+len;
    END LOOP;
  ELSIF p_type='image/png' THEN
    IF substring(p FROM 1 FOR 8)<>'\x89504e470d0a1a0a'::bytea THEN RETURN false; END IF;
    pos:=8;
    LOOP
      IF pos+12>n THEN RETURN false; END IF;
      len:=((get_byte(p,pos)::bigint*256+get_byte(p,pos+1))*256+get_byte(p,pos+2))*256+get_byte(p,pos+3);
      typ:=convert_from(substring(p FROM pos+5 FOR 4),'SQL_ASCII');
      IF len>n OR pos+12+len>n THEN RETURN false; END IF;
      IF NOT seen_ihdr AND typ<>'IHDR' THEN RETURN false; END IF;
      seen_ihdr:=true;
      IF typ IN ('tEXt','zTXt','iTXt','eXIf') THEN RETURN false; END IF;
      IF typ='IDAT' THEN seen_image:=true; END IF;
      IF typ='IEND' THEN RETURN seen_image AND pos+12+len=n; END IF;
      pos:=pos+12+len::integer;
    END LOOP;
  ELSIF p_type='image/webp' THEN
    IF substring(p FROM 1 FOR 4)<>'\x52494646'::bytea OR substring(p FROM 9 FOR 4)<>'\x57454250'::bytea THEN RETURN false; END IF;
    len:=get_byte(p,4)+get_byte(p,5)*256+get_byte(p,6)*65536+get_byte(p,7)::bigint*16777216;
    IF len+8<>n THEN RETURN false; END IF;
    pos:=12;
    WHILE pos<n LOOP
      IF pos+8>n THEN RETURN false; END IF;
      typ:=convert_from(substring(p FROM pos+1 FOR 4),'SQL_ASCII');
      len:=get_byte(p,pos+4)+get_byte(p,pos+5)*256+get_byte(p,pos+6)*65536+get_byte(p,pos+7)::bigint*16777216;
      IF pos+8+len>n THEN RETURN false; END IF;
      IF typ IN ('EXIF','XMP ') THEN RETURN false; END IF;
      IF typ IN ('VP8 ','VP8L') THEN seen_image:=true; END IF;
      pos:=pos+8+len::integer+(len%2)::integer;
    END LOOP;
    RETURN seen_image AND pos=n;
  END IF;
  RETURN false;
END $$;

-- A set as staff see it. A set past its expiry that no command has erased yet already reads as erased.
CREATE FUNCTION hon.paper_import_summary(s hon.paper_import_sets) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',s.id,'kind',s.kind,'target',s.target,'version',s.version,
    'status',CASE WHEN x.expired THEN 'DELETED' ELSE s.status END,
    'pageCount',CASE WHEN x.expired OR s.status='DELETED' THEN 0 ELSE s.page_count END,
    'reader',s.reader,'readOutcome',s.read_outcome,'sentBatchId',s.sent_batch_id,
    'createdAt',hon.saas_ts(s.created_at),'expiresAt',hon.saas_ts(s.expires_at),'readAt',hon.saas_ts(s.read_at),
    'sentAt',hon.saas_ts(s.sent_at),
    'deletedAt',CASE WHEN x.expired THEN hon.saas_ts(s.expires_at) ELSE hon.saas_ts(s.deleted_at) END,
    'deleteReason',CASE WHEN x.expired THEN 'EXPIRED' ELSE s.delete_reason END)
  FROM (SELECT s.status<>'DELETED' AND s.expires_at<=clock_timestamp() AS expired) x
$$;

CREATE FUNCTION hon.paper_import_detail(s hon.paper_import_sets) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('set',hon.paper_import_summary(s),'columns',to_jsonb(hon.paper_import_columns(s.target)),
    'rows',CASE WHEN x.gone THEN '[]'::jsonb ELSE coalesce(s.table_rows,'[]'::jsonb) END,
    'unsure',CASE WHEN x.gone THEN '[]'::jsonb ELSE coalesce(s.table_unsure,'[]'::jsonb) END,
    'pages',CASE WHEN x.gone THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('pageNo',p.page_no,'mediaType',p.media_type,
      'bytes',octet_length(p.content),'checksum',p.checksum) ORDER BY p.page_no),'[]'::jsonb) FROM hon.paper_import_pages p WHERE p.set_id=s.id) END)
  FROM (SELECT s.status='DELETED' OR s.expires_at<=clock_timestamp() AS gone) x
$$;

-- Erasure: the set becomes DELETED with no table, then its pages are deleted (the page guard admits only this).
CREATE FUNCTION hon.paper_import_erase(p_set uuid,p_reason text,p_actor uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  UPDATE hon.paper_import_sets SET version=version+1,status='DELETED',table_rows=NULL,table_unsure=NULL,deleted_at=clock_timestamp(),
    deleted_by_principal_id=CASE WHEN p_reason='STAFF' THEN p_actor END,delete_reason=p_reason
  WHERE id=p_set AND status<>'DELETED';
  DELETE FROM hon.paper_import_pages WHERE set_id=p_set;
END $$;

-- Expired sets of one school are erased by the next command there. hon.purge_expired_paper_imports() erases them in
-- every school for a scheduled job run by the migration owner; it is not granted to the app.
CREATE FUNCTION hon.paper_import_purge_school(p_org uuid,p_school uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s uuid; n integer:=0;
BEGIN
  FOR s IN SELECT id FROM hon.paper_import_sets WHERE organization_id=p_org AND school_id=p_school AND status<>'DELETED'
    AND expires_at<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED LOOP
    PERFORM hon.paper_import_erase(s,'EXPIRED',NULL); n:=n+1;
  END LOOP;
  RETURN n;
END $$;
CREATE FUNCTION hon.purge_expired_paper_imports() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s uuid; n integer:=0;
BEGIN
  FOR s IN SELECT id FROM hon.paper_import_sets WHERE status<>'DELETED' AND expires_at<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED LOOP
    PERFORM hon.paper_import_erase(s,'EXPIRED',NULL); n:=n+1;
  END LOOP;
  RETURN n;
END $$;

-- Common command prologue (as 0226): validated request ids, live import authority, expired sets erased, key
-- reservation, exact replay only while authority is current.
CREATE FUNCTION hon.paper_import_begin(p_subject text,p_operation text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prior hon.paper_import_requests%ROWTYPE;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('create','page','save','send','delete') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  BEGIN actor:=hon.require_student_import_actor(p_subject);
  EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'PAPER_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END;
  PERFORM hon.paper_import_purge_school(org,school);
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  INSERT INTO hon.paper_import_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.paper_import_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_BUSY' USING ERRCODE='55P03'; END IF;
    replay:=prior.response;
  END IF;
END $$;

-- Authority for a step without an idempotency key (reads, and the two halves of the one reading per set).
CREATE FUNCTION hon.require_paper_import_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN hon.require_student_import_actor(p_subject);
EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'PAPER_IMPORT_FORBIDDEN' USING ERRCODE='42501';
END $$;

-- Common epilogue: identifier-only audit and inert outbox, request completion, then authority decided again after the
-- last write. Responses hold the set summary only: never a page, a table or a name.
CREATE FUNCTION hon.paper_import_finish(p_subject text,p_actor uuid,p_operation text,p_set uuid,p_key text,p_request uuid,p_correlation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb; v integer;
BEGIN
  SELECT version INTO v FROM hon.paper_import_sets WHERE id=p_set;
  payload:=jsonb_build_object('setId',p_set,'operation',p_operation,'version',v,'internalOnly',true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','students.paper_import.'||p_operation,'PAPER_IMPORT_SET',p_set,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'students.paper_import.'||p_operation,1,'PAPER_IMPORT_SET',p_set,v,p_correlation,p_request,payload);
  IF p_key IS NOT NULL THEN
    UPDATE hon.paper_import_requests SET response=p_result,completed_at=clock_timestamp()
      WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key;
  END IF;
  IF hon.require_paper_import_actor(p_subject) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'PAPER_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;

CREATE FUNCTION hon.paper_import_lock(p_set uuid,p_version jsonb) RETURNS hon.paper_import_sets
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.paper_import_sets%ROWTYPE;
BEGIN
  SELECT * INTO s FROM hon.paper_import_sets WHERE id=p_set AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_version IS NOT NULL AND (jsonb_typeof(p_version) IS DISTINCT FROM 'number' OR (p_version#>>'{}') !~ '^[1-9][0-9]{0,8}$') THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  IF s.status='DELETED' THEN RAISE EXCEPTION 'PAPER_IMPORT_GONE' USING ERRCODE='P0002'; END IF;
  IF p_version IS NOT NULL AND s.version<>(p_version#>>'{}')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN s;
END $$;

-- Input: exactly {kind}.
CREATE FUNCTION hon.create_paper_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; r hon.paper_import_sets%ROWTYPE; at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO s FROM hon.paper_import_begin(p_subject,'create',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['kind'] OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string'
    OR p_input->>'kind' NOT IN ('STUDENT_CARDS','CONTRACTS','ATTENDANCE_SHEETS') THEN RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.paper_import_sets(organization_id,school_id,kind,target,created_by_principal_id,created_at,expires_at)
    VALUES(hon.current_organization_id(),hon.current_school_id(),p_input->>'kind',CASE p_input->>'kind' WHEN 'ATTENDANCE_SHEETS' THEN 'ATTENDANCE' ELSE 'STUDENTS' END,
      s.actor,at,at+interval '30 days') RETURNING * INTO r;
  RETURN hon.paper_import_finish(p_subject,s.actor,'create',r.id,p_key,p_request,p_correlation,hon.paper_import_summary(r));
END $$;

-- Input: exactly {expectedVersion, mediaType, data} with data the base64 of the already metadata-free image.
CREATE FUNCTION hon.add_paper_import_page(p_subject text,p_set uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; r hon.paper_import_sets%ROWTYPE; bytes bytea; sum text;
BEGIN
  SELECT * INTO s FROM hon.paper_import_begin(p_subject,'page',p_input||jsonb_build_object('setId',p_set),p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['data','expectedVersion','mediaType']
    OR jsonb_typeof(p_input->'mediaType') IS DISTINCT FROM 'string' OR p_input->>'mediaType' NOT IN ('image/jpeg','image/png','image/webp')
    OR jsonb_typeof(p_input->'data') IS DISTINCT FROM 'string' OR length(p_input->>'data') NOT BETWEEN 4 AND 1866668
    OR length(p_input->>'data')%4<>0 OR (p_input->>'data') !~ '^[A-Za-z0-9+/]+={0,2}$' THEN RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  r:=hon.paper_import_lock(p_set,p_input->'expectedVersion');
  IF r.status<>'OPEN' THEN RAISE EXCEPTION 'PAPER_IMPORT_ALREADY_READ' USING ERRCODE='40001'; END IF;
  -- Once a reading has begun, the pages are fixed: a page added now would never be read yet sit beside the table.
  -- (A reading that never finished is begun again with Read, which still reads exactly these pages.)
  IF r.reading_id IS NOT NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_ALREADY_READ' USING ERRCODE='40001'; END IF;
  IF r.page_count>=10 THEN RAISE EXCEPTION 'PAPER_IMPORT_TOO_MANY_PAGES' USING ERRCODE='22023'; END IF;
  bytes:=decode(p_input->>'data','base64');
  IF octet_length(bytes) NOT BETWEEN 1 AND 1400000 OR NOT hon.paper_import_image_clean(p_input->>'mediaType',bytes) THEN
    RAISE EXCEPTION 'PAPER_IMPORT_IMAGE_REFUSED' USING ERRCODE='22023'; END IF;
  sum:=encode(sha256(bytes),'hex');
  IF sum=ANY(r.page_checksums) THEN RAISE EXCEPTION 'PAPER_IMPORT_PAGE_DUPLICATE' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.paper_import_pages(set_id,organization_id,school_id,page_no,media_type,content,checksum)
    VALUES(r.id,r.organization_id,r.school_id,r.page_count+1,p_input->>'mediaType',bytes,sum);
  UPDATE hon.paper_import_sets SET version=version+1,page_count=page_count+1,page_checksums=page_checksums||sum WHERE id=r.id RETURNING * INTO r;
  RETURN hon.paper_import_finish(p_subject,s.actor,'page',r.id,p_key,p_request,p_correlation,hon.paper_import_summary(r));
END $$;

-- Reading, step 1 (no key: a set is read once). An already read set returns {done:true} and is never read again.
-- Otherwise the AI spend decision comes first: an HQ pause, lapsed access or the school cost ceiling refuses before
-- anything else. Returns what the stand-in reader needs: the kind and the page checksums (no image bytes).
CREATE FUNCTION hon.begin_paper_reading(p_subject text,p_set uuid,p_input jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; r hon.paper_import_sets%ROWTYPE; why text;
BEGIN
  IF p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR p_input IS NULL OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['expectedVersion'] THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_paper_import_actor(p_subject);
  PERFORM hon.paper_import_purge_school(hon.current_organization_id(),hon.current_school_id());
  r:=hon.paper_import_lock(p_set,NULL);
  IF r.status<>'OPEN' THEN RETURN jsonb_build_object('done',true); END IF;
  r:=hon.paper_import_lock(p_set,p_input->'expectedVersion');
  IF r.page_count<1 THEN RAISE EXCEPTION 'PAPER_IMPORT_NO_PAGES' USING ERRCODE='22023'; END IF;
  why:=hon.ai_spend_allowed(r.organization_id,r.school_id,clock_timestamp(),'AGENT_INFERENCE');
  IF why IS NOT NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_AI_BLOCKED' USING ERRCODE='42501',DETAIL=why; END IF;
  UPDATE hon.paper_import_sets SET version=version+1,reading_id=gen_random_uuid(),reading_started_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
  PERFORM hon.paper_import_finish(p_subject,actor,'read.start',r.id,NULL,p_request,p_correlation,'{}'::jsonb);
  RETURN jsonb_build_object('done',false,'readingId',r.reading_id,'kind',r.kind,'checksums',to_jsonb(r.page_checksums));
END $$;

-- Reading, step 2: the result of the current reading only. Input: exactly {readingId, reader, outcome, rows, unsure}.
CREATE FUNCTION hon.record_paper_reading(p_subject text,p_set uuid,p_input jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; r hon.paper_import_sets%ROWTYPE;
BEGIN
  IF p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR p_input IS NULL OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['outcome','reader','readingId','rows','unsure']
    OR jsonb_typeof(p_input->'readingId') IS DISTINCT FROM 'string' OR (p_input->>'readingId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_input->'reader' IS DISTINCT FROM '"SYNTHETIC"'::jsonb
    OR jsonb_typeof(p_input->'outcome') IS DISTINCT FROM 'string' OR p_input->>'outcome' NOT IN ('SAMPLE_READ','NOT_READABLE') THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_paper_import_actor(p_subject);
  r:=hon.paper_import_lock(p_set,NULL);
  IF r.status<>'OPEN' OR r.reading_id IS DISTINCT FROM (p_input->>'readingId')::uuid THEN RAISE EXCEPTION 'PAPER_IMPORT_READING_STALE' USING ERRCODE='40001'; END IF;
  IF NOT hon.paper_import_table_ok(r.target,p_input->'rows',p_input->'unsure')
    OR (p_input->>'outcome'='NOT_READABLE' AND jsonb_array_length(p_input->'rows')<>0) THEN RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  UPDATE hon.paper_import_sets SET version=version+1,status='READ',reader='SYNTHETIC',read_outcome=p_input->>'outcome',read_at=clock_timestamp(),
    table_rows=p_input->'rows',table_unsure=p_input->'unsure' WHERE id=r.id RETURNING * INTO r;
  PERFORM hon.paper_import_finish(p_subject,actor,'read.record',r.id,NULL,p_request,p_correlation,'{}'::jsonb);
  RETURN hon.paper_import_detail(r);
END $$;

-- Input: exactly {expectedVersion, rows, unsure}. Staff corrections to a read table; only before it is sent.
CREATE FUNCTION hon.save_paper_import_table(p_subject text,p_set uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; r hon.paper_import_sets%ROWTYPE;
BEGIN
  SELECT * INTO s FROM hon.paper_import_begin(p_subject,'save',p_input||jsonb_build_object('setId',p_set),p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['expectedVersion','rows','unsure'] THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  r:=hon.paper_import_lock(p_set,p_input->'expectedVersion');
  IF r.status<>'READ' THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_EDITABLE' USING ERRCODE='40001'; END IF;
  IF NOT hon.paper_import_table_ok(r.target,p_input->'rows',p_input->'unsure') THEN RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  UPDATE hon.paper_import_sets SET version=version+1,table_rows=p_input->'rows',table_unsure=p_input->'unsure' WHERE id=r.id RETURNING * INTO r;
  RETURN hon.paper_import_finish(p_subject,s.actor,'save',r.id,p_key,p_request,p_correlation,hon.paper_import_summary(r));
END $$;

-- One CSV field, always quoted.
CREATE FUNCTION hon.paper_import_csv_field(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT '"'||replace(p,'"','""')||'"' $$;

-- Input: exactly {expectedVersion}. Blank rows are dropped; the rest become CSV text with one column per field and go
-- through the existing stage function under a key derived from the set, in this transaction. The import then checks every
-- cell and staff decide every row there. The set records the batch it created.
CREATE FUNCTION hon.send_paper_import(p_subject text,p_set uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; r hon.paper_import_sets%ROWTYPE; cols text[]; kept jsonb; csv text; staged jsonb; batch uuid; n integer;
BEGIN
  SELECT * INTO s FROM hon.paper_import_begin(p_subject,'send',p_input||jsonb_build_object('setId',p_set),p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['expectedVersion'] THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  r:=hon.paper_import_lock(p_set,p_input->'expectedVersion');
  IF r.status<>'READ' THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_EDITABLE' USING ERRCODE='40001'; END IF;
  cols:=hon.paper_import_columns(r.target);
  SELECT coalesce(jsonb_agg(x.row ORDER BY x.i),'[]'::jsonb) INTO kept FROM jsonb_array_elements(r.table_rows) WITH ORDINALITY x(row,i)
    WHERE EXISTS(SELECT 1 FROM jsonb_array_elements_text(x.row) c WHERE c<>'');
  n:=jsonb_array_length(kept);
  IF n=0 THEN RAISE EXCEPTION 'PAPER_IMPORT_TABLE_EMPTY' USING ERRCODE='22023'; END IF;
  csv:=(SELECT string_agg(hon.paper_import_csv_field(c),',' ORDER BY i) FROM unnest(cols) WITH ORDINALITY u(c,i))||E'\n'
    ||(SELECT string_agg((SELECT string_agg(hon.paper_import_csv_field(c),',' ORDER BY j) FROM jsonb_array_elements_text(x.row) WITH ORDINALITY y(c,j)),E'\n' ORDER BY x.i)
       FROM jsonb_array_elements(kept) WITH ORDINALITY x(row,i))||E'\n';
  IF octet_length(csv)>262144 THEN RAISE EXCEPTION 'PAPER_IMPORT_TABLE_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF r.target='STUDENTS' THEN
    staged:=hon.stage_student_import(p_subject,jsonb_build_object('csv',csv,'headers',to_jsonb(cols),
      'mapping',(SELECT jsonb_object_agg(c,c) FROM unnest(cols) c),'rows',kept),'paper-import:'||r.id::text,p_request,p_correlation);
  ELSE
    staged:=hon.stage_history_import(p_subject,jsonb_build_object('kind','ATTENDANCE','csv',csv,'headers',to_jsonb(cols),
      'mapping',(SELECT jsonb_object_agg(c,c) FROM unnest(cols) c),'rows',kept),'paper-import:'||r.id::text,p_request,p_correlation);
  END IF;
  batch:=(staged->'record'->>'id')::uuid;
  IF batch IS NULL OR (staged->>'replayed')::boolean THEN RAISE EXCEPTION 'PAPER_IMPORT_SEND_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.paper_import_sets SET version=version+1,status='SENT',sent_batch_id=batch,sent_row_count=n,sent_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
  RETURN hon.paper_import_finish(p_subject,s.actor,'send',r.id,p_key,p_request,p_correlation,hon.paper_import_summary(r));
END $$;

-- Input: exactly {}. Erases the pages and the table at once, in any state; the set row stays as the audit record.
CREATE FUNCTION hon.delete_paper_import(p_subject text,p_set uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; r hon.paper_import_sets%ROWTYPE;
BEGIN
  SELECT * INTO s FROM hon.paper_import_begin(p_subject,'delete',p_input||jsonb_build_object('setId',p_set),p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF p_input<>'{}'::jsonb THEN RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM hon.paper_import_sets WHERE id=p_set AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.paper_import_erase(r.id,'STAFF',s.actor);
  SELECT * INTO r FROM hon.paper_import_sets WHERE id=p_set;
  RETURN hon.paper_import_finish(p_subject,s.actor,'delete',r.id,p_key,p_request,p_correlation,hon.paper_import_summary(r));
END $$;

-- Reads: the 25 most recent sets, one set with its table and page list, or one page image. All need the same live
-- import authority as the commands. A deleted or expired set returns no page.
CREATE FUNCTION hon.read_paper_imports(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_paper_import_actor(p_subject);
  SELECT jsonb_build_object('sets',coalesce(jsonb_agg(hon.paper_import_summary(x) ORDER BY x.created_at DESC,x.id),'[]'::jsonb),
    'maxPages',10,'maxPageBytes',1400000,'maxRows',200,'retentionDays',30) INTO result
  FROM (SELECT * FROM hon.paper_import_sets WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
    ORDER BY created_at DESC,id LIMIT 25) x;
  RETURN result;
END $$;

CREATE FUNCTION hon.read_paper_import(p_subject text,p_set uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.paper_import_sets%ROWTYPE;
BEGIN
  PERFORM hon.require_paper_import_actor(p_subject);
  SELECT * INTO r FROM hon.paper_import_sets WHERE id=p_set AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.paper_import_detail(r);
END $$;

CREATE FUNCTION hon.read_paper_import_page(p_subject text,p_set uuid,p_page integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_paper_import_actor(p_subject);
  SELECT jsonb_build_object('pageNo',p.page_no,'mediaType',p.media_type,'data',translate(encode(p.content,'base64'),E'\n',''))
    INTO result FROM hon.paper_import_pages p JOIN hon.paper_import_sets s ON s.id=p.set_id
  WHERE p.set_id=p_set AND p.page_no=p_page AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id()
    AND s.status<>'DELETED' AND s.expires_at>clock_timestamp();
  IF result IS NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN result;
END $$;

-- Deny first, then exactly the ten entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['paper_import_sets','paper_import_pages','paper_import_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_paper_import()','hon.paper_import_columns(text)','hon.paper_import_cell_ok(jsonb)',
    'hon.paper_import_table_ok(text,jsonb,jsonb)','hon.paper_import_image_clean(text,bytea)','hon.paper_import_summary(hon.paper_import_sets)',
    'hon.paper_import_detail(hon.paper_import_sets)','hon.paper_import_erase(uuid,text,uuid)','hon.paper_import_purge_school(uuid,uuid)',
    'hon.purge_expired_paper_imports()','hon.paper_import_begin(text,text,jsonb,text,uuid,uuid)','hon.require_paper_import_actor(text)',
    'hon.paper_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)','hon.paper_import_lock(uuid,jsonb)','hon.paper_import_csv_field(text)',
    'hon.create_paper_import(text,jsonb,text,uuid,uuid)','hon.add_paper_import_page(text,uuid,jsonb,text,uuid,uuid)',
    'hon.begin_paper_reading(text,uuid,jsonb,uuid,uuid)','hon.record_paper_reading(text,uuid,jsonb,uuid,uuid)',
    'hon.save_paper_import_table(text,uuid,jsonb,text,uuid,uuid)','hon.send_paper_import(text,uuid,jsonb,text,uuid,uuid)',
    'hon.delete_paper_import(text,uuid,jsonb,text,uuid,uuid)','hon.read_paper_imports(text)','hon.read_paper_import(text,uuid)',
    'hon.read_paper_import_page(text,uuid,integer)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_paper_import(text,jsonb,text,uuid,uuid),hon.add_paper_import_page(text,uuid,jsonb,text,uuid,uuid),
      hon.begin_paper_reading(text,uuid,jsonb,uuid,uuid),hon.record_paper_reading(text,uuid,jsonb,uuid,uuid),
      hon.save_paper_import_table(text,uuid,jsonb,text,uuid,uuid),hon.send_paper_import(text,uuid,jsonb,text,uuid,uuid),
      hon.delete_paper_import(text,uuid,jsonb,text,uuid,uuid),hon.read_paper_imports(text),hon.read_paper_import(text,uuid),
      hon.read_paper_import_page(text,uuid,integer) TO hon_runtime;
  END IF;
END $$;

COMMIT;
