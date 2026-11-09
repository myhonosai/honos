BEGIN;

-- B-CRM-7 (0226, owner-allocated 2026-11-09): a school moving from another system stages a CSV of students and their
-- guardians, decides each row (IMPORT or SKIP), then finalizes. Finalizing creates people, families, family links and
-- student profiles only. No membership, plan, schedule, invoice, payment, enrollment, account, invitation, consent,
-- message, automation, AI or credit effect. The runtime role gets EXECUTE on five entry points and nothing on any table.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.membership_local_date(timestamptz,text)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL THEN RAISE EXCEPTION '0226 requires 0154, 0177 and the staff eligibility helper'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
  VALUES('students.import','Stage, review and import student and guardian records from a CSV file',true,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,'students.import' FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE TABLE hon.student_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  status text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED','FINALIZED')),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  headers jsonb NOT NULL CHECK (jsonb_typeof(headers)='array'),
  mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping)='object'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 1000),
  valid_count integer NOT NULL CHECK (valid_count BETWEEN 0 AND row_count),
  school_today date NOT NULL,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_by_principal_id uuid REFERENCES hon.principals(id),
  finalized_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  UNIQUE (id,organization_id,school_id),
  CHECK ((status='FINALIZED')=(finalized_at IS NOT NULL) AND (finalized_at IS NULL)=(finalized_by_principal_id IS NULL))
);
CREATE INDEX student_import_batches_scope_idx ON hon.student_import_batches(organization_id,school_id,created_at DESC,id);

CREATE TABLE hon.student_import_rows (
  batch_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  row_index integer NOT NULL CHECK (row_index BETWEEN 1 AND 1000),
  source_row jsonb NOT NULL CHECK (jsonb_typeof(source_row)='array'),
  normalized jsonb NOT NULL CHECK (jsonb_typeof(normalized)='object'),
  validation_errors jsonb NOT NULL CHECK (jsonb_typeof(validation_errors)='array'),
  suggestions jsonb NOT NULL CHECK (jsonb_typeof(suggestions)='array'),
  choice text CHECK (choice IN ('IMPORT','SKIP')),
  family_id uuid, guardian_person_id uuid, student_person_id uuid UNIQUE, student_profile_id uuid UNIQUE,
  PRIMARY KEY (batch_id,row_index),
  FOREIGN KEY (batch_id,organization_id,school_id) REFERENCES hon.student_import_batches(id,organization_id,school_id),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id),
  FOREIGN KEY (guardian_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id),
  FOREIGN KEY (student_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id),
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  CHECK ((student_person_id IS NULL)=(student_profile_id IS NULL) AND (student_person_id IS NULL)=(family_id IS NULL)),
  CHECK (student_person_id IS NULL OR (choice='IMPORT' AND validation_errors='[]'::jsonb)),
  CHECK (guardian_person_id IS NULL OR student_person_id IS NOT NULL)
);

CREATE TABLE hon.student_import_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('stage','decide','finalize')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

ALTER TABLE hon.student_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_import_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_import_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_import_requests FORCE ROW LEVEL SECURITY;

-- Evidence guard: nothing is ever deleted; a batch only advances its version (and finalizes once); a row keeps its
-- staged content, changes its choice only while undecided-to-applied, and records created ids once; a request records
-- its response once.
CREATE FUNCTION hon.guard_student_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE st text;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'STUDENT_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='student_import_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'STUDENT_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF TG_TABLE_NAME='student_import_batches' THEN
    IF OLD.status='FINALIZED' OR NEW.version<>OLD.version+1
      OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.source_checksum,NEW.headers,NEW.mapping,NEW.row_count,NEW.valid_count,NEW.school_today,NEW.created_by_principal_id,NEW.created_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.source_checksum,OLD.headers,OLD.mapping,OLD.row_count,OLD.valid_count,OLD.school_today,OLD.created_by_principal_id,OLD.created_at) THEN
      RAISE EXCEPTION 'STUDENT_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT b.status INTO st FROM hon.student_import_batches b WHERE b.id=OLD.batch_id;
    IF st IS DISTINCT FROM 'STAGED' OR OLD.student_person_id IS NOT NULL
      OR (NEW.batch_id,NEW.organization_id,NEW.school_id,NEW.row_index,NEW.source_row,NEW.normalized,NEW.validation_errors,NEW.suggestions)
        IS DISTINCT FROM (OLD.batch_id,OLD.organization_id,OLD.school_id,OLD.row_index,OLD.source_row,OLD.normalized,OLD.validation_errors,OLD.suggestions)
      OR (NEW.choice IS DISTINCT FROM OLD.choice AND NEW.student_person_id IS NOT NULL)
      OR (NEW.choice IS NULL AND OLD.choice IS NOT NULL) THEN
      RAISE EXCEPTION 'STUDENT_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER student_import_batches_guard BEFORE UPDATE OR DELETE ON hon.student_import_batches FOR EACH ROW EXECUTE FUNCTION hon.guard_student_import();
CREATE TRIGGER student_import_rows_guard BEFORE UPDATE OR DELETE ON hon.student_import_rows FOR EACH ROW EXECUTE FUNCTION hon.guard_student_import();
CREATE TRIGGER student_import_requests_guard BEFORE UPDATE OR DELETE ON hon.student_import_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_student_import();
CREATE TRIGGER student_import_batches_no_truncate BEFORE TRUNCATE ON hon.student_import_batches FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_student_import();
CREATE TRIGGER student_import_rows_no_truncate BEFORE TRUNCATE ON hon.student_import_rows FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_student_import();
CREATE TRIGGER student_import_requests_no_truncate BEFORE TRUNCATE ON hon.student_import_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_student_import();

-- Live direct-human staff authority at the session school, decided against clock_timestamp() (so a grant, school,
-- organization or paid access that ends while a command waits is seen when authority is decided again), or an error.
CREATE FUNCTION hon.require_student_import_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'STUDENT_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='students.import' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'STUDENT_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.student_import_fields() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['studentGivenName','studentFamilyName','birthDate','studentEmail','studentMobile',
    'guardianGivenName','guardianFamilyName','guardianEmail','guardianMobile','familyKey']
$$;

-- One raw row against the staged headers and mapping: every mapped cell is revalidated here, never trusted from the API.
-- Ignored columns are dropped from the stored row. Returns {sourceRow, normalized, errors}.
CREATE FUNCTION hon.student_import_check_row(p_headers jsonb,p_mapping jsonb,p_row jsonb,p_today date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n jsonb:='{}'; errors jsonb:='[]'; src jsonb:='[]'; field text; raw text; v text; i integer; maxlen integer; d date;
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'array' OR jsonb_array_length(p_row)<>jsonb_array_length(p_headers) THEN
    RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  FOR i IN 0..jsonb_array_length(p_headers)-1 LOOP
    IF jsonb_typeof(p_row->i) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
    field:=p_mapping->>(p_headers->>i);
    IF field='ignore' THEN src:=src||jsonb_build_array(''); CONTINUE; END IF;
    raw:=p_row->>i; v:=btrim(raw); src:=src||jsonb_build_array(raw);
    maxlen:=CASE WHEN field IN ('studentEmail','guardianEmail') THEN 254 WHEN field IN ('studentMobile','guardianMobile') THEN 40
      WHEN field='familyKey' THEN 80 WHEN field='birthDate' THEN 10 ELSE 120 END;
    IF length(v)>maxlen THEN errors:=errors||jsonb_build_array(field||':TOO_LONG'); END IF;
    IF raw ~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿�]' THEN errors:=errors||jsonb_build_array(field||':CONTROL_CHARACTER'); END IF;
    -- A valid international phone is the only plus-prefixed exception to the spreadsheet formula rule.
    IF v ~ '^[=+@-]' AND NOT (field IN ('studentMobile','guardianMobile') AND v ~ '^\+[1-9][0-9 ()-]{6,25}$') THEN
      errors:=errors||jsonb_build_array(field||':FORMULA_INJECTION'); END IF;
    IF field IN ('studentEmail','guardianEmail') AND v<>'' THEN
      v:=lower(v);
      IF v !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$' THEN errors:=errors||jsonb_build_array(field||':INVALID'); END IF;
    END IF;
    IF field IN ('studentMobile','guardianMobile') AND v<>'' THEN
      v:=regexp_replace(v,'[ ()-]','','g');
      IF v !~ '^\+[1-9][0-9]{6,14}$' THEN errors:=errors||jsonb_build_array(field||':USE_E164'); END IF;
    END IF;
    IF field='birthDate' AND v<>'' THEN
      d:=NULL;
      IF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        BEGIN d:=to_date(v,'YYYY-MM-DD'); IF to_char(d,'YYYY-MM-DD')<>v THEN d:=NULL; END IF; EXCEPTION WHEN OTHERS THEN d:=NULL; END;
      END IF;
      IF d IS NULL THEN errors:=errors||jsonb_build_array('birthDate:USE_YYYY_MM_DD');
      ELSIF d>p_today OR d<p_today-interval '120 years' THEN errors:=errors||jsonb_build_array('birthDate:OUT_OF_RANGE'); END IF;
    END IF;
    n:=n||jsonb_build_object(field,v);
  END LOOP;
  IF coalesce(n->>'studentGivenName','')='' OR coalesce(n->>'studentFamilyName','')='' THEN errors:=errors||jsonb_build_array('student:NAME_REQUIRED'); END IF;
  IF (coalesce(n->>'guardianGivenName','')<>'' OR coalesce(n->>'guardianFamilyName','')<>'' OR coalesce(n->>'guardianEmail','')<>'' OR coalesce(n->>'guardianMobile','')<>'')
    AND (coalesce(n->>'guardianGivenName','')='' OR coalesce(n->>'guardianFamilyName','')='') THEN errors:=errors||jsonb_build_array('guardian:NAME_REQUIRED'); END IF;
  RETURN jsonb_build_object('sourceRow',src,'normalized',n,'errors',errors);
END $$;

CREATE FUNCTION hon.student_import_guardian(n jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  -- A guardian exists only with both names; a half-named guardian is an error on the row, never a guardian.
  SELECT CASE WHEN coalesce(n->>'guardianGivenName','')='' OR coalesce(n->>'guardianFamilyName','')='' THEN NULL ELSE jsonb_build_object(
    'givenName',n->>'guardianGivenName','familyName',n->>'guardianFamilyName',
    'email',coalesce(n->>'guardianEmail',''),'mobile',coalesce(n->>'guardianMobile','')) END
$$;

CREATE FUNCTION hon.student_import_summary(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',b.id,'version',b.version,'status',b.status,'rowCount',b.row_count,'validCount',b.valid_count,
    'importCount',(SELECT count(*) FROM hon.student_import_rows r WHERE r.batch_id=b.id AND r.choice='IMPORT'),
    'skipCount',(SELECT count(*) FROM hon.student_import_rows r WHERE r.batch_id=b.id AND r.choice='SKIP'),
    'undecidedCount',(SELECT count(*) FROM hon.student_import_rows r WHERE r.batch_id=b.id AND r.choice IS NULL),
    'importedCount',(SELECT count(*) FROM hon.student_import_rows r WHERE r.batch_id=b.id AND r.student_person_id IS NOT NULL),
    'checksum',b.source_checksum,'schoolToday',to_char(b.school_today,'YYYY-MM-DD'),
    'createdAt',hon.saas_ts(b.created_at),'finalizedAt',hon.saas_ts(b.finalized_at))
  FROM hon.student_import_batches b WHERE b.id=p_batch
$$;

CREATE FUNCTION hon.student_import_detail(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('batch',hon.student_import_summary(b.id),'headers',b.headers,'mapping',b.mapping,
    'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('index',r.row_index,'raw',r.source_row,'normalized',r.normalized,
      'errors',r.validation_errors,'suggestions',r.suggestions,'choice',r.choice,
      'created',CASE WHEN r.student_person_id IS NULL THEN NULL ELSE jsonb_build_object('familyId',r.family_id,
        'guardianPersonId',r.guardian_person_id,'studentPersonId',r.student_person_id,'studentProfileId',r.student_profile_id) END)
      ORDER BY r.row_index),'[]'::jsonb) FROM hon.student_import_rows r WHERE r.batch_id=b.id))
  FROM hon.student_import_batches b WHERE b.id=p_batch
$$;

-- Common command prologue. Order: authority -> (finalize: hon.people ROW EXCLUSIVE, the same table order as the CRM
-- registration flows) -> key reservation -> exact replay only while authority is current. Returns the stored response
-- on replay, or NULL when the caller must do the work.
CREATE FUNCTION hon.student_import_begin(p_subject text,p_operation text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prior hon.student_import_requests%ROWTYPE;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('stage','decide','finalize') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_student_import_actor(p_subject);
  IF p_operation='finalize' THEN LOCK TABLE hon.people IN ROW EXCLUSIVE MODE; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  INSERT INTO hon.student_import_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.student_import_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'STUDENT_IMPORT_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.require_student_import_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STUDENT_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
    replay:=prior.response;
  END IF;
END $$;

-- Common epilogue: audit, inert outbox, request completion, then authority decided again after the last write.
CREATE FUNCTION hon.student_import_finish(p_subject text,p_actor uuid,p_operation text,p_batch uuid,p_key text,p_request uuid,p_correlation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb; v integer;
BEGIN
  SELECT version INTO v FROM hon.student_import_batches WHERE id=p_batch;
  payload:=jsonb_build_object('batchId',p_batch,'operation',p_operation,'version',v,'internalOnly',true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','students.import.'||p_operation,'STUDENT_IMPORT_BATCH',p_batch,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'students.import.'||p_operation,1,'STUDENT_IMPORT_BATCH',p_batch,v,p_correlation,p_request,payload);
  UPDATE hon.student_import_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key;
  IF hon.require_student_import_actor(p_subject) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'STUDENT_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;

-- Input: exactly {csv, headers, mapping, rows}. The API parses the CSV; the database recomputes the checksum of the
-- exact text and revalidates every mapped cell, the guardian grouping and the minor rule.
CREATE FUNCTION hon.stage_student_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record;
  headers jsonb; mapping jsonb; rows jsonb; fields text[]; cell jsonb; item jsonb; checked jsonb; idx integer; tz text; today date;
  b hon.student_import_batches%ROWTYPE; n jsonb; errs jsonb; g jsonb; groups jsonb:='{}'; k text; d date; valid integer:=0;
  staged jsonb:='[]'; v_final jsonb:='[]';
BEGIN
  SELECT * INTO s FROM hon.student_import_begin(p_subject,'stage',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['csv','headers','mapping','rows']
    OR jsonb_typeof(p_input->'csv') IS DISTINCT FROM 'string' OR octet_length(p_input->>'csv') NOT BETWEEN 1 AND 262144 OR (p_input->>'csv') ~ '�'
    OR jsonb_typeof(p_input->'headers') IS DISTINCT FROM 'array' OR jsonb_typeof(p_input->'mapping') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_input->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  headers:=p_input->'headers'; mapping:=p_input->'mapping'; rows:=p_input->'rows';
  IF jsonb_array_length(headers) NOT BETWEEN 1 AND 24 OR jsonb_array_length(rows) NOT BETWEEN 1 AND 1000
    OR (SELECT count(DISTINCT h) FROM jsonb_array_elements_text(headers) h)<>jsonb_array_length(headers)
    OR (SELECT count(*) FROM jsonb_object_keys(mapping))<>jsonb_array_length(headers) THEN RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  FOR cell IN SELECT * FROM jsonb_array_elements(headers) LOOP
    IF jsonb_typeof(cell)<>'string' OR length(btrim(cell#>>'{}')) NOT BETWEEN 1 AND 80 OR (cell#>>'{}') ~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]'
      OR (cell#>>'{}') ~ '^[[:space:]]*[=+@-]' OR NOT mapping ? (cell#>>'{}') OR jsonb_typeof(mapping->(cell#>>'{}'))<>'string' THEN
      RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT array_agg(v) INTO fields FROM jsonb_each_text(mapping) x(k,v) WHERE v<>'ignore';
  IF EXISTS(SELECT 1 FROM jsonb_each_text(mapping) x(k,v) WHERE v<>'ignore' AND v<>ALL(hon.student_import_fields()))
    OR fields IS NULL OR cardinality(fields)<>(SELECT count(DISTINCT x) FROM unnest(fields) x)
    OR NOT ('studentGivenName'=ANY(fields) AND 'studentFamilyName'=ANY(fields))
    OR ('guardianGivenName'=ANY(fields))<>('guardianFamilyName'=ANY(fields))
    OR (('guardianEmail'=ANY(fields) OR 'guardianMobile'=ANY(fields)) AND NOT 'guardianGivenName'=ANY(fields)) THEN
    RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT timezone INTO tz FROM hon.schools WHERE id=school AND organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(clock_timestamp(),tz);

  -- Pass 1: every cell, and the one guardian each family key names (two different guardians under one key is a mismatch).
  idx:=0;
  FOR item IN SELECT * FROM jsonb_array_elements(rows) LOOP
    idx:=idx+1; checked:=hon.student_import_check_row(headers,mapping,item,today);
    staged:=staged||jsonb_build_array(checked||jsonb_build_object('index',idx));
    k:=lower(coalesce(checked->'normalized'->>'familyKey',''));
    g:=hon.student_import_guardian(checked->'normalized');
    IF k<>'' AND g IS NOT NULL THEN
      IF NOT groups ? k THEN groups:=groups||jsonb_build_object(k,g);
      ELSIF groups->k IS DISTINCT FROM g THEN groups:=groups||jsonb_build_object(k,'"MISMATCH"'::jsonb); END IF;
    END IF;
  END LOOP;
  -- Pass 2: the row's guardian (its own, or its family key's) and the minor rule: a known minor needs a guardian, and a
  -- row with no guardian needs a birth date so an adult is never assumed.
  FOR item IN SELECT * FROM jsonb_array_elements(staged) LOOP
    n:=item->'normalized'; errs:=item->'errors'; k:=lower(coalesce(n->>'familyKey','')); g:=hon.student_import_guardian(n);
    IF k<>'' AND groups ? k THEN
      IF groups->k='"MISMATCH"'::jsonb THEN errs:=errs||'["familyKey:GUARDIAN_MISMATCH"]'::jsonb; g:=NULL; ELSE g:=groups->k; END IF;
    END IF;
    d:=CASE WHEN coalesce(n->>'birthDate','')<>'' AND NOT errs ? 'birthDate:USE_YYYY_MM_DD' AND NOT errs ? 'birthDate:OUT_OF_RANGE'
      THEN to_date(n->>'birthDate','YYYY-MM-DD') END;
    IF g IS NULL AND NOT errs ? 'familyKey:GUARDIAN_MISMATCH' THEN
      IF d IS NOT NULL AND d>today-interval '18 years' THEN errs:=errs||'["guardian:REQUIRED_FOR_MINOR"]'::jsonb;
      ELSIF coalesce(n->>'birthDate','')='' THEN errs:=errs||'["birthDate:REQUIRED_WITHOUT_GUARDIAN"]'::jsonb; END IF;
    END IF;
    IF errs='[]'::jsonb THEN valid:=valid+1; END IF;
    v_final:=v_final||jsonb_build_array(jsonb_build_object('index',item->'index','sourceRow',item->'sourceRow','normalized',n||jsonb_build_object('guardian',g),'errors',errs));
  END LOOP;

  INSERT INTO hon.student_import_batches(organization_id,school_id,source_checksum,headers,mapping,row_count,valid_count,school_today,created_by_principal_id)
    VALUES(org,school,encode(sha256(convert_to(p_input->>'csv','UTF8')),'hex'),headers,mapping,jsonb_array_length(rows),valid,today,s.actor) RETURNING * INTO b;
  -- Advisory duplicate suggestions (never merged): existing people at this exact school by contact, existing students by
  -- name and birth date, and repeats of the same student inside this file. At most 20 per row.
  INSERT INTO hon.student_import_rows(batch_id,organization_id,school_id,row_index,source_row,normalized,validation_errors,suggestions)
  SELECT b.id,org,school,(t->>'index')::integer,t->'sourceRow',t->'normalized',t->'errors',coalesce((
    SELECT jsonb_agg(x ORDER BY x::text COLLATE "C") FROM (SELECT x FROM (SELECT DISTINCT x FROM (
      SELECT jsonb_build_object('personId',p.id,'reason','STUDENT_EMAIL') x FROM hon.people p WHERE p.organization_id=org AND p.school_id=school
        AND coalesce(t->'normalized'->>'studentEmail','')<>'' AND lower(p.email::text)=t->'normalized'->>'studentEmail'
      UNION ALL SELECT jsonb_build_object('personId',p.id,'reason','STUDENT_PHONE') FROM hon.people p WHERE p.organization_id=org AND p.school_id=school
        AND coalesce(t->'normalized'->>'studentMobile','')<>'' AND p.phone_e164=t->'normalized'->>'studentMobile'
      UNION ALL SELECT jsonb_build_object('personId',p.id,'reason','GUARDIAN_EMAIL') FROM hon.people p WHERE p.organization_id=org AND p.school_id=school
        AND coalesce(t->'normalized'->'guardian'->>'email','')<>'' AND lower(p.email::text)=t->'normalized'->'guardian'->>'email'
      UNION ALL SELECT jsonb_build_object('personId',p.id,'reason','GUARDIAN_PHONE') FROM hon.people p WHERE p.organization_id=org AND p.school_id=school
        AND coalesce(t->'normalized'->'guardian'->>'mobile','')<>'' AND p.phone_e164=t->'normalized'->'guardian'->>'mobile'
      UNION ALL SELECT jsonb_build_object('personId',p.id,'reason','STUDENT_NAME_AND_BIRTH_DATE') FROM hon.student_profiles sp
        JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
        WHERE sp.organization_id=org AND sp.school_id=school AND coalesce(t->'normalized'->>'birthDate','')<>''
          AND lower(p.given_name)=lower(t->'normalized'->>'studentGivenName') AND lower(p.family_name)=lower(t->'normalized'->>'studentFamilyName')
          AND to_char(sp.birth_date,'YYYY-MM-DD')=t->'normalized'->>'birthDate'
      UNION ALL SELECT jsonb_build_object('rowIndex',(o->>'index')::integer,'reason','SAME_STUDENT_IN_FILE') FROM jsonb_array_elements(v_final) o
        WHERE o->'index'<>t->'index' AND coalesce(t->'normalized'->>'studentGivenName','')<>''
          AND lower(coalesce(o->'normalized'->>'studentGivenName',''))=lower(t->'normalized'->>'studentGivenName')
          AND lower(coalesce(o->'normalized'->>'studentFamilyName',''))=lower(coalesce(t->'normalized'->>'studentFamilyName',''))
          AND coalesce(o->'normalized'->>'birthDate','')=coalesce(t->'normalized'->>'birthDate','')
    ) a) dedup ORDER BY x::text COLLATE "C" LIMIT 20) top),'[]'::jsonb)
  FROM jsonb_array_elements(v_final) t;
  RETURN hon.student_import_finish(p_subject,s.actor,'stage',b.id,p_key,p_request,p_correlation,hon.student_import_summary(b.id));
END $$;

-- Input: exactly {batchId, expectedVersion, decisions:[{index, choice}]}. IMPORT is accepted only for a row without errors.
CREATE FUNCTION hon.decide_student_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; b hon.student_import_batches%ROWTYPE; item jsonb; v_choice text; idx integer;
BEGIN
  SELECT * INTO s FROM hon.student_import_begin(p_subject,'decide',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['batchId','decisions','expectedVersion']
    OR jsonb_typeof(p_input->'batchId') IS DISTINCT FROM 'string' OR (p_input->>'batchId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'decisions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'decisions') NOT BETWEEN 1 AND 1000
    OR (SELECT count(DISTINCT d->>'index') FROM jsonb_array_elements(p_input->'decisions') d)<>jsonb_array_length(p_input->'decisions') THEN
    RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.student_import_batches WHERE id=(p_input->>'batchId')::uuid AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.status<>'STAGED' OR b.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_input->'decisions') LOOP
    IF jsonb_typeof(item)<>'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(item) x) IS DISTINCT FROM ARRAY['choice','index']
      OR jsonb_typeof(item->'index') IS DISTINCT FROM 'number' OR (item->>'index') !~ '^[1-9][0-9]{0,3}$' OR item->>'choice' IS NULL OR item->>'choice' NOT IN ('IMPORT','SKIP') THEN
      RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
    idx:=(item->>'index')::integer; v_choice:=item->>'choice';
    UPDATE hon.student_import_rows SET choice=v_choice WHERE batch_id=b.id AND row_index=idx AND student_person_id IS NULL
      AND (v_choice='SKIP' OR validation_errors='[]'::jsonb);
    IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE' USING ERRCODE='22023'; END IF;
  END LOOP;
  UPDATE hon.student_import_batches SET version=version+1 WHERE id=b.id;
  RETURN hon.student_import_finish(p_subject,s.actor,'decide',b.id,p_key,p_request,p_correlation,hon.student_import_summary(b.id));
END $$;

-- One IMPORT row: a family (shared with earlier rows of the same family key), its guardian once, the student, the
-- family links and the student profile. INSERT only; never a merge into an existing person.
CREATE FUNCTION hon.apply_student_import_row(p_batch uuid,p_row integer,p_actor uuid,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); r hon.student_import_rows%ROWTYPE; n jsonb; g jsonb; k text;
  fam uuid; guardian uuid; student uuid; profile uuid; payload jsonb;
BEGIN
  SELECT * INTO r FROM hon.student_import_rows WHERE batch_id=p_batch AND row_index=p_row AND choice='IMPORT' AND validation_errors='[]'::jsonb AND student_person_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE' USING ERRCODE='40001'; END IF;
  n:=r.normalized; g:=CASE WHEN jsonb_typeof(n->'guardian')='object' THEN n->'guardian' END; k:=lower(coalesce(n->>'familyKey',''));
  IF k<>'' THEN
    SELECT x.family_id,x.guardian_person_id INTO fam,guardian FROM hon.student_import_rows x
      WHERE x.batch_id=p_batch AND x.student_person_id IS NOT NULL AND lower(coalesce(x.normalized->>'familyKey',''))=k ORDER BY x.row_index LIMIT 1;
  END IF;
  IF fam IS NULL THEN
    INSERT INTO hon.families(organization_id,school_id,display_name)
      VALUES(org,school,left(coalesce(nullif(g->>'familyName',''),n->>'studentFamilyName')||' family',200)) RETURNING id INTO fam;
    IF g IS NOT NULL THEN
      INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
        VALUES(org,school,g->>'givenName',g->>'familyName',nullif(g->>'email',''),nullif(g->>'mobile','')) RETURNING id INTO guardian;
      INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES(org,school,fam,guardian,'GUARDIAN',false);
    END IF;
  END IF;
  INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
    VALUES(org,school,n->>'studentGivenName',n->>'studentFamilyName',nullif(n->>'studentEmail',''),nullif(n->>'studentMobile','')) RETURNING id INTO student;
  INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES(org,school,fam,student,'STUDENT',false);
  INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date)
    VALUES(org,school,student,fam,CASE WHEN coalesce(n->>'birthDate','')<>'' THEN to_date(n->>'birthDate','YYYY-MM-DD') END) RETURNING id INTO profile;
  UPDATE hon.student_import_rows SET family_id=fam,guardian_person_id=guardian,student_person_id=student,student_profile_id=profile WHERE batch_id=p_batch AND row_index=p_row;
  -- Identifiers only: never a name, contact value or birth date in audit or outbox.
  payload:=jsonb_build_object('batchId',p_batch,'rowIndex',p_row,'familyId',fam,'guardianPersonId',guardian,'studentPersonId',student,'studentProfileId',profile,'internalOnly',true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','students.import.row_applied','STUDENT_PROFILE',profile,payload,'SUCCEEDED',p_request,p_correlation);
  -- Deliberately not a student or family "created" event: imported records start no welcome, automation or message.
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'students.import.row_applied',1,'STUDENT_PROFILE',profile,1,p_correlation,p_request,payload);
END $$;

-- Input: exactly {batchId, expectedVersion, selectedIndices}. Every row must be decided, and the selection must equal
-- exactly the IMPORT rows, so nothing is imported that staff did not choose on this version.
CREATE FUNCTION hon.finalize_student_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; b hon.student_import_batches%ROWTYPE; sel jsonb; expected jsonb; idx integer;
BEGIN
  SELECT * INTO s FROM hon.student_import_begin(p_subject,'finalize',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['batchId','expectedVersion','selectedIndices']
    OR jsonb_typeof(p_input->'batchId') IS DISTINCT FROM 'string' OR (p_input->>'batchId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'selectedIndices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'selectedIndices')>1000
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'selectedIndices') x WHERE jsonb_typeof(x)<>'number' OR (x#>>'{}') !~ '^[1-9][0-9]{0,3}$')
    OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_input->'selectedIndices') x)<>jsonb_array_length(p_input->'selectedIndices') THEN
    RAISE EXCEPTION 'STUDENT_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.student_import_batches WHERE id=(p_input->>'batchId')::uuid AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.status<>'STAGED' OR b.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  SELECT coalesce(jsonb_agg(row_index ORDER BY row_index),'[]'::jsonb) INTO expected FROM hon.student_import_rows WHERE batch_id=b.id AND choice='IMPORT';
  SELECT coalesce(jsonb_agg(x ORDER BY (x#>>'{}')::integer),'[]'::jsonb) INTO sel FROM jsonb_array_elements(p_input->'selectedIndices') x;
  IF sel<>expected OR EXISTS(SELECT 1 FROM hon.student_import_rows WHERE batch_id=b.id AND choice IS NULL) THEN
    RAISE EXCEPTION 'STUDENT_IMPORT_SELECTION_REQUIRED' USING ERRCODE='40001'; END IF;
  FOR idx IN SELECT row_index FROM hon.student_import_rows WHERE batch_id=b.id AND choice='IMPORT' ORDER BY row_index LOOP
    PERFORM hon.apply_student_import_row(b.id,idx,s.actor,p_request,p_correlation);
  END LOOP;
  UPDATE hon.student_import_batches SET version=version+1,status='FINALIZED',finalized_at=clock_timestamp(),finalized_by_principal_id=s.actor WHERE id=b.id;
  RETURN hon.student_import_finish(p_subject,s.actor,'finalize',b.id,p_key,p_request,p_correlation,hon.student_import_summary(b.id));
END $$;

-- Reads: the 25 most recent batches, or one batch with its rows. Rows hold names, contacts and birth dates, so both
-- reads need the same live import authority as the commands.
CREATE FUNCTION hon.read_student_imports(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  PERFORM hon.require_student_import_actor(p_subject);
  SELECT jsonb_build_object('batches',coalesce(jsonb_agg(hon.student_import_summary(x.id) ORDER BY x.created_at DESC,x.id),'[]'::jsonb),
    'fields',to_jsonb(hon.student_import_fields()),'maxBytes',262144,'maxRows',1000,'maxColumns',24) INTO result
  FROM (SELECT id,created_at FROM hon.student_import_batches WHERE organization_id=org AND school_id=school ORDER BY created_at DESC,id LIMIT 25) x;
  RETURN result;
END $$;

CREATE FUNCTION hon.read_student_import(p_subject text,p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_student_import_actor(p_subject);
  IF p_batch IS NULL OR NOT EXISTS(SELECT 1 FROM hon.student_import_batches WHERE id=p_batch AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN
    RAISE EXCEPTION 'STUDENT_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.student_import_detail(p_batch);
END $$;

-- Deny first, then exactly the five entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['student_import_batches','student_import_rows','student_import_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_student_import()','hon.require_student_import_actor(text)','hon.student_import_fields()',
    'hon.student_import_check_row(jsonb,jsonb,jsonb,date)','hon.student_import_guardian(jsonb)','hon.student_import_summary(uuid)',
    'hon.student_import_detail(uuid)','hon.student_import_begin(text,text,jsonb,text,uuid,uuid)',
    'hon.student_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)','hon.stage_student_import(text,jsonb,text,uuid,uuid)',
    'hon.decide_student_import(text,jsonb,text,uuid,uuid)','hon.apply_student_import_row(uuid,integer,uuid,uuid,uuid)',
    'hon.finalize_student_import(text,jsonb,text,uuid,uuid)','hon.read_student_imports(text)','hon.read_student_import(text,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.stage_student_import(text,jsonb,text,uuid,uuid),hon.decide_student_import(text,jsonb,text,uuid,uuid),
      hon.finalize_student_import(text,jsonb,text,uuid,uuid),hon.read_student_imports(text),hon.read_student_import(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
