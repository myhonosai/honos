BEGIN;

-- Onboarding B6 (0333, coordinator-allocated 2026-11-13): a school moving from another system stages a CSV of its weekly
-- classes or of its students' attendance history, decides each row (IMPORT or SKIP), then finalizes. Same staged and
-- reviewed shape as the 0226 student import.
--   CLASSES     each row becomes one weekly class series (0239) under a program matched by name or created (DRAFT). No
--               session is created: filling the timetable stays the existing staff command, and "ongoing" stays OFF.
--   ATTENDANCE  each row is a past visit count for one existing student, matched by name (and birth date when given). It
--               is kept as imported history only: never a class session, booking or attendance record, so no rank, badge,
--               retention, reward, automation, message or charge counts it or reacts to it.
-- Nothing here creates a membership, plan, invoice, payment, enrollment, account, invitation, consent, message, AI call
-- or credit effect. The runtime role gets EXECUTE on six entry points and nothing on any table.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.class_series') IS NULL OR to_regclass('hon.student_import_batches') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.membership_local_date(timestamptz,text)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='students.import') OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='schedule.session.manage') THEN
    RAISE EXCEPTION '0333 requires 0226 and 0239';
  END IF;
END $$;

CREATE TABLE hon.history_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CLASSES','ATTENDANCE')),
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
CREATE INDEX history_import_batches_scope_idx ON hon.history_import_batches(organization_id,school_id,created_at DESC,id);

-- Imported attendance history: one past visit count per row. Never a session, booking or attendance record.
CREATE TABLE hon.imported_attendance_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  attended_on date NOT NULL,
  visit_count integer NOT NULL CHECK (visit_count BETWEEN 1 AND 5000),
  class_name text CHECK (class_name IS NULL OR (length(class_name) BETWEEN 1 AND 120 AND btrim(class_name)=class_name)),
  batch_id uuid NOT NULL, row_index integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  FOREIGN KEY (batch_id,organization_id,school_id) REFERENCES hon.history_import_batches(id,organization_id,school_id),
  UNIQUE (batch_id,row_index), UNIQUE (id,organization_id,school_id)
);
CREATE INDEX imported_attendance_history_student_idx ON hon.imported_attendance_history(organization_id,school_id,student_profile_id,attended_on);

CREATE TABLE hon.history_import_rows (
  batch_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  row_index integer NOT NULL CHECK (row_index BETWEEN 1 AND 1000),
  source_row jsonb NOT NULL CHECK (jsonb_typeof(source_row)='array'),
  normalized jsonb NOT NULL CHECK (jsonb_typeof(normalized)='object'),
  validation_errors jsonb NOT NULL CHECK (jsonb_typeof(validation_errors)='array'),
  choice text CHECK (choice IN ('IMPORT','SKIP')),
  matched_profile_id uuid,
  program_id uuid, series_id uuid UNIQUE, history_id uuid UNIQUE,
  PRIMARY KEY (batch_id,row_index),
  FOREIGN KEY (batch_id,organization_id,school_id) REFERENCES hon.history_import_batches(id,organization_id,school_id),
  FOREIGN KEY (matched_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  FOREIGN KEY (program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id),
  FOREIGN KEY (series_id,organization_id,school_id) REFERENCES hon.class_series(id,organization_id,school_id),
  FOREIGN KEY (history_id,organization_id,school_id) REFERENCES hon.imported_attendance_history(id,organization_id,school_id),
  CHECK ((series_id IS NULL)=(program_id IS NULL)),
  CHECK (series_id IS NULL OR history_id IS NULL),
  CHECK ((series_id IS NULL AND history_id IS NULL) OR (choice='IMPORT' AND validation_errors='[]'::jsonb))
);

CREATE TABLE hon.history_import_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('stage','decide','finalize')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

ALTER TABLE hon.history_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.history_import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.history_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.history_import_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.history_import_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.history_import_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.imported_attendance_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.imported_attendance_history FORCE ROW LEVEL SECURITY;

-- Evidence guard: nothing is deleted; history is never changed; a batch only advances its version (and finalizes once);
-- a row keeps its staged content and match, changes its choice only before it is applied, and records created ids once;
-- a request records its response once.
CREATE FUNCTION hon.guard_history_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE st text;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') OR TG_TABLE_NAME='imported_attendance_history' THEN RAISE EXCEPTION 'HISTORY_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='history_import_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'HISTORY_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF TG_TABLE_NAME='history_import_batches' THEN
    IF OLD.status='FINALIZED' OR NEW.version<>OLD.version+1
      OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.kind,NEW.source_checksum,NEW.headers,NEW.mapping,NEW.row_count,NEW.valid_count,NEW.school_today,NEW.created_by_principal_id,NEW.created_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.kind,OLD.source_checksum,OLD.headers,OLD.mapping,OLD.row_count,OLD.valid_count,OLD.school_today,OLD.created_by_principal_id,OLD.created_at) THEN
      RAISE EXCEPTION 'HISTORY_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT b.status INTO st FROM hon.history_import_batches b WHERE b.id=OLD.batch_id;
    IF st IS DISTINCT FROM 'STAGED' OR OLD.series_id IS NOT NULL OR OLD.history_id IS NOT NULL
      OR (NEW.batch_id,NEW.organization_id,NEW.school_id,NEW.row_index,NEW.source_row,NEW.normalized,NEW.validation_errors,NEW.matched_profile_id)
        IS DISTINCT FROM (OLD.batch_id,OLD.organization_id,OLD.school_id,OLD.row_index,OLD.source_row,OLD.normalized,OLD.validation_errors,OLD.matched_profile_id)
      OR (NEW.choice IS DISTINCT FROM OLD.choice AND (NEW.series_id IS NOT NULL OR NEW.history_id IS NOT NULL))
      OR (NEW.choice IS NULL AND OLD.choice IS NOT NULL) THEN
      RAISE EXCEPTION 'HISTORY_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_import_batches_guard BEFORE UPDATE OR DELETE ON hon.history_import_batches FOR EACH ROW EXECUTE FUNCTION hon.guard_history_import();
CREATE TRIGGER history_import_rows_guard BEFORE UPDATE OR DELETE ON hon.history_import_rows FOR EACH ROW EXECUTE FUNCTION hon.guard_history_import();
CREATE TRIGGER history_import_requests_guard BEFORE UPDATE OR DELETE ON hon.history_import_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_history_import();
CREATE TRIGGER imported_attendance_history_guard BEFORE UPDATE OR DELETE ON hon.imported_attendance_history FOR EACH ROW EXECUTE FUNCTION hon.guard_history_import();
CREATE TRIGGER history_import_batches_no_truncate BEFORE TRUNCATE ON hon.history_import_batches FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_history_import();
CREATE TRIGGER history_import_rows_no_truncate BEFORE TRUNCATE ON hon.history_import_rows FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_history_import();
CREATE TRIGGER history_import_requests_no_truncate BEFORE TRUNCATE ON hon.history_import_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_history_import();
CREATE TRIGGER imported_attendance_history_no_truncate BEFORE TRUNCATE ON hon.imported_attendance_history FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_history_import();

-- Live direct-human staff authority at the session school, decided against clock_timestamp(), or an error. Every import
-- needs students.import (the 0226 import permission); a class import also needs schedule.session.manage (the 0239
-- permission that creates class series), so no import creates what its sender could not create by hand.
CREATE FUNCTION hon.require_history_import_actor(p_subject text,p_kind text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; need text[];
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_kind IS NULL OR p_kind NOT IN ('ANY','CLASSES','ATTENDANCE') THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  need:=CASE WHEN p_kind='CLASSES' THEN ARRAY['students.import','schedule.session.manage'] ELSE ARRAY['students.import'] END;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND (SELECT count(DISTINCT x.code) FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=ANY(need) AND x.is_staff_assignable)=cardinality(need)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'HISTORY_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.history_import_fields(p_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_kind
    WHEN 'CLASSES' THEN ARRAY['className','programName','weekdays','startTime','durationMinutes','capacity','roomName','bookingPolicy','startsOn']
    WHEN 'ATTENDANCE' THEN ARRAY['studentGivenName','studentFamilyName','birthDate','attendedOn','visits','className'] END
$$;
CREATE FUNCTION hon.history_import_required(p_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_kind WHEN 'CLASSES' THEN ARRAY['className','weekdays','startTime','durationMinutes']
    WHEN 'ATTENDANCE' THEN ARRAY['studentGivenName','studentFamilyName','attendedOn'] END
$$;

-- A strict calendar date, or NULL.
CREATE FUNCTION hon.history_import_date(v text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE d date;
BEGIN
  IF v IS NULL OR v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  BEGIN d:=to_date(v,'YYYY-MM-DD'); EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
  RETURN CASE WHEN to_char(d,'YYYY-MM-DD')=v THEN d END;
END $$;

-- "Mon, Wed" / "Monday/Wednesday" / "1 3" (ISO 1=Monday) -> sorted ISO weekdays, or NULL when any part is unknown.
CREATE FUNCTION hon.history_import_weekdays(v text) RETURNS smallint[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE part text; d smallint; days smallint[]:='{}';
BEGIN
  FOREACH part IN ARRAY regexp_split_to_array(lower(btrim(v)),'[\s,;/&+]+') LOOP
    CONTINUE WHEN part='' OR part='and';
    d:=CASE WHEN part ~ '^[1-7]$' THEN part::smallint
      WHEN part IN ('mon','monday') THEN 1 WHEN part IN ('tue','tues','tuesday') THEN 2 WHEN part IN ('wed','wednesday') THEN 3
      WHEN part IN ('thu','thur','thurs','thursday') THEN 4 WHEN part IN ('fri','friday') THEN 5 WHEN part IN ('sat','saturday') THEN 6
      WHEN part IN ('sun','sunday') THEN 7 END;
    IF d IS NULL THEN RETURN NULL; END IF;
    IF NOT d=ANY(days) THEN days:=days||d; END IF;
  END LOOP;
  IF cardinality(days)=0 THEN RETURN NULL; END IF;
  RETURN ARRAY(SELECT x FROM unnest(days) x ORDER BY x);
END $$;

-- "18:30", "6:30 PM", "6pm" -> HH24:MI, or NULL.
CREATE FUNCTION hon.history_import_time(v text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE m text[]; h integer; mi integer;
BEGIN
  m:=regexp_match(lower(btrim(v)),'^([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$');
  IF m IS NULL THEN RETURN NULL; END IF;
  h:=m[1]::integer; mi:=coalesce(m[2],'0')::integer;
  IF mi>59 THEN RETURN NULL; END IF;
  IF m[3] IS NULL THEN
    IF m[2] IS NULL OR h>23 THEN RETURN NULL; END IF;
  ELSE
    IF h NOT BETWEEN 1 AND 12 THEN RETURN NULL; END IF;
    h:=CASE WHEN left(m[3],1)='a' THEN h%12 ELSE h%12+12 END;
  END IF;
  RETURN lpad(h::text,2,'0')||':'||lpad(mi::text,2,'0');
END $$;

-- One raw row against the staged kind, headers and mapping: every mapped cell is revalidated here, never trusted from
-- the API. Ignored columns are dropped from the stored row. Returns {sourceRow, normalized, errors}.
CREATE FUNCTION hon.history_import_check_row(p_kind text,p_headers jsonb,p_mapping jsonb,p_row jsonb,p_today date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE n jsonb:='{}'; errors jsonb:='[]'; src jsonb:='[]'; field text; raw text; v text; i integer; d date; days smallint[]; t text;
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'array' OR jsonb_array_length(p_row)<>jsonb_array_length(p_headers) THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  FOR i IN 0..jsonb_array_length(p_headers)-1 LOOP
    IF jsonb_typeof(p_row->i) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
    field:=p_mapping->>(p_headers->>i);
    IF field='ignore' THEN src:=src||jsonb_build_array(''); CONTINUE; END IF;
    raw:=p_row->>i; v:=btrim(raw); src:=src||jsonb_build_array(raw);
    IF length(v)>120 THEN errors:=errors||jsonb_build_array(field||':TOO_LONG'); END IF;
    IF raw ~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿�]' THEN errors:=errors||jsonb_build_array(field||':CONTROL_CHARACTER'); END IF;
    IF v ~ '^[=+@-]' THEN errors:=errors||jsonb_build_array(field||':FORMULA_INJECTION'); END IF;
    IF v<>'' THEN
      IF field IN ('birthDate','attendedOn','startsOn') THEN
        d:=hon.history_import_date(v);
        IF d IS NULL THEN errors:=errors||jsonb_build_array(field||':USE_YYYY_MM_DD');
        ELSIF field='birthDate' AND (d>p_today OR d<p_today-interval '120 years') THEN errors:=errors||jsonb_build_array('birthDate:OUT_OF_RANGE');
        ELSIF field='attendedOn' AND (d>p_today OR d<p_today-interval '50 years') THEN errors:=errors||jsonb_build_array('attendedOn:OUT_OF_RANGE');
        -- 0239 accepts a first date at most seven days back; a year ahead is the most a school plans here.
        ELSIF field='startsOn' AND (d<p_today-7 OR d>p_today+365) THEN errors:=errors||jsonb_build_array('startsOn:OUT_OF_RANGE'); END IF;
      ELSIF field='weekdays' THEN
        days:=hon.history_import_weekdays(v);
        IF days IS NULL THEN errors:=errors||jsonb_build_array('weekdays:UNKNOWN_DAY'); ELSE v:=array_to_string(days,','); END IF;
      ELSIF field='startTime' THEN
        t:=hon.history_import_time(v);
        IF t IS NULL THEN errors:=errors||jsonb_build_array('startTime:USE_HH_MM'); ELSE v:=t; END IF;
      ELSIF field='durationMinutes' THEN
        IF v !~ '^[0-9]{1,3}$' OR v::integer NOT BETWEEN 5 AND 600 THEN errors:=errors||jsonb_build_array('durationMinutes:OUT_OF_RANGE'); END IF;
      ELSIF field='capacity' THEN
        IF v !~ '^[0-9]{1,4}$' OR v::integer NOT BETWEEN 1 AND 1000 THEN errors:=errors||jsonb_build_array('capacity:OUT_OF_RANGE'); END IF;
      ELSIF field='visits' THEN
        IF v !~ '^[0-9]{1,4}$' OR v::integer NOT BETWEEN 1 AND 5000 THEN errors:=errors||jsonb_build_array('visits:OUT_OF_RANGE'); END IF;
      ELSIF field='bookingPolicy' THEN
        v:=upper(regexp_replace(v,'[\s-]+','_','g'));
        v:=CASE WHEN v IN ('WALK_IN','WALKIN','DROP_IN') THEN 'WALK_IN' WHEN v IN ('OPTIONAL','OPTIONAL_BOOKING') THEN 'OPTIONAL_BOOKING'
          WHEN v IN ('REQUIRED','REQUIRED_BOOKING','BOOKING_REQUIRED') THEN 'REQUIRED_BOOKING' END;
        IF v IS NULL THEN errors:=errors||jsonb_build_array('bookingPolicy:UNKNOWN'); v:=''; END IF;
      END IF;
    END IF;
    n:=n||jsonb_build_object(field,v);
  END LOOP;
  FOREACH field IN ARRAY hon.history_import_required(p_kind) LOOP
    IF coalesce(n->>field,'')='' THEN errors:=errors||jsonb_build_array(field||':REQUIRED'); END IF;
  END LOOP;
  IF p_kind='CLASSES' THEN
    -- Stated defaults, shown on review: the program is named after the class, 20 places, walk-in, starting today.
    n:=n||jsonb_build_object('programName',coalesce(nullif(n->>'programName',''),n->>'className',''),
      'capacity',coalesce(nullif(n->>'capacity',''),'20'),'bookingPolicy',coalesce(nullif(n->>'bookingPolicy',''),'WALK_IN'),
      'startsOn',coalesce(nullif(n->>'startsOn',''),to_char(p_today,'YYYY-MM-DD')),'roomName',coalesce(n->>'roomName',''));
  ELSE
    n:=n||jsonb_build_object('visits',coalesce(nullif(n->>'visits',''),'1'),'className',coalesce(n->>'className',''),'birthDate',coalesce(n->>'birthDate',''));
  END IF;
  RETURN jsonb_build_object('sourceRow',src,'normalized',n,'errors',errors);
END $$;

CREATE FUNCTION hon.history_import_summary(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',b.id,'kind',b.kind,'version',b.version,'status',b.status,'rowCount',b.row_count,'validCount',b.valid_count,
    'importCount',(SELECT count(*) FROM hon.history_import_rows r WHERE r.batch_id=b.id AND r.choice='IMPORT'),
    'skipCount',(SELECT count(*) FROM hon.history_import_rows r WHERE r.batch_id=b.id AND r.choice='SKIP'),
    'undecidedCount',(SELECT count(*) FROM hon.history_import_rows r WHERE r.batch_id=b.id AND r.choice IS NULL),
    'importedCount',(SELECT count(*) FROM hon.history_import_rows r WHERE r.batch_id=b.id AND (r.series_id IS NOT NULL OR r.history_id IS NOT NULL)),
    'checksum',b.source_checksum,'schoolToday',to_char(b.school_today,'YYYY-MM-DD'),
    'createdAt',hon.saas_ts(b.created_at),'finalizedAt',hon.saas_ts(b.finalized_at))
  FROM hon.history_import_batches b WHERE b.id=p_batch
$$;

CREATE FUNCTION hon.history_import_detail(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('batch',hon.history_import_summary(b.id),'headers',b.headers,'mapping',b.mapping,
    'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('index',r.row_index,'raw',r.source_row,'normalized',r.normalized,
      'errors',r.validation_errors,'choice',r.choice,'matchedStudentProfileId',r.matched_profile_id,
      'created',CASE WHEN r.series_id IS NOT NULL THEN jsonb_build_object('programId',r.program_id,'seriesId',r.series_id)
        WHEN r.history_id IS NOT NULL THEN jsonb_build_object('historyId',r.history_id) END)
      ORDER BY r.row_index),'[]'::jsonb) FROM hon.history_import_rows r WHERE r.batch_id=b.id))
  FROM hon.history_import_batches b WHERE b.id=p_batch
$$;

-- Common command prologue: authority -> (finalize: the table locks of the records it creates) -> key reservation ->
-- exact replay only while authority is current. Returns the stored response on replay, or NULL when the caller works.
CREATE FUNCTION hon.history_import_begin(p_subject text,p_kind text,p_operation text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prior hon.history_import_requests%ROWTYPE;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('stage','decide','finalize') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_history_import_actor(p_subject,p_kind);
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  INSERT INTO hon.history_import_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.history_import_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'HISTORY_IMPORT_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.require_history_import_actor(p_subject,p_kind) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'HISTORY_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
    replay:=prior.response;
  END IF;
END $$;

-- Common epilogue: audit, inert outbox, request completion, then authority decided again after the last write.
CREATE FUNCTION hon.history_import_finish(p_subject text,p_kind text,p_actor uuid,p_operation text,p_batch uuid,p_key text,p_request uuid,p_correlation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb; v integer;
BEGIN
  SELECT version INTO v FROM hon.history_import_batches WHERE id=p_batch;
  payload:=jsonb_build_object('batchId',p_batch,'kind',p_kind,'operation',p_operation,'version',v,'internalOnly',true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','history.import.'||p_operation,'HISTORY_IMPORT_BATCH',p_batch,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'history.import.'||p_operation,1,'HISTORY_IMPORT_BATCH',p_batch,v,p_correlation,p_request,payload);
  UPDATE hon.history_import_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key;
  IF hon.require_history_import_actor(p_subject,p_kind) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'HISTORY_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;

-- An ACTIVE series at the session school with the same class name (any case), weekdays and start time as a CLASSES row.
-- A school can keep two classes of one name at different times; only the same class twice is refused.
CREATE FUNCTION hon.history_import_class_exists(n jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(n->>'weekdays','') ~ '^[1-7](,[1-7])*$' AND coalesce(n->>'startTime','') ~ '^[0-2][0-9]:[0-5][0-9]$' AND EXISTS(
    SELECT 1 FROM hon.class_series x WHERE x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id() AND x.status='ACTIVE'
      AND lower(x.name)=lower(n->>'className') AND x.weekdays=string_to_array(n->>'weekdays',',')::smallint[]
      AND to_char(x.local_start_time,'HH24:MI')=n->>'startTime')
$$;

-- The batch of a decide or finalize body (its kind decides the authority), locked, or an error.
CREATE FUNCTION hon.history_import_batch_kind(p_subject text,p_input jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE k text;
BEGIN
  -- Import authority first, so a caller without it cannot learn whether a batch exists.
  PERFORM hon.require_history_import_actor(p_subject,'ANY');
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR jsonb_typeof(p_input->'batchId') IS DISTINCT FROM 'string'
    OR (p_input->>'batchId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT kind INTO k FROM hon.history_import_batches WHERE id=(p_input->>'batchId')::uuid AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  IF k IS NULL THEN RAISE EXCEPTION 'HISTORY_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN k;
END $$;

-- Input: exactly {kind, csv, headers, mapping, rows}. The API parses the CSV; the database recomputes the checksum of the
-- exact text, revalidates every mapped cell, matches attendance rows to existing students and flags repeats.
CREATE FUNCTION hon.stage_history_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; v_kind text;
  headers jsonb; mapping jsonb; rows jsonb; fields text[]; cell jsonb; item jsonb; checked jsonb; idx integer:=0; tz text; today date;
  b hon.history_import_batches%ROWTYPE; n jsonb; errs jsonb; valid integer:=0; matches uuid[]; profile uuid; seen jsonb:='{}'; sig text; staged jsonb:='[]';
BEGIN
  v_kind:=CASE WHEN jsonb_typeof(p_input)='object' AND jsonb_typeof(p_input->'kind')='string' AND p_input->>'kind' IN ('CLASSES','ATTENDANCE') THEN p_input->>'kind' END;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.history_import_begin(p_subject,v_kind,'stage',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['csv','headers','kind','mapping','rows']
    OR jsonb_typeof(p_input->'csv') IS DISTINCT FROM 'string' OR octet_length(p_input->>'csv') NOT BETWEEN 1 AND 262144 OR (p_input->>'csv') ~ '�'
    OR jsonb_typeof(p_input->'headers') IS DISTINCT FROM 'array' OR jsonb_typeof(p_input->'mapping') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_input->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  headers:=p_input->'headers'; mapping:=p_input->'mapping'; rows:=p_input->'rows';
  IF jsonb_array_length(headers) NOT BETWEEN 1 AND 24 OR jsonb_array_length(rows) NOT BETWEEN 1 AND 1000
    OR (SELECT count(DISTINCT h) FROM jsonb_array_elements_text(headers) h)<>jsonb_array_length(headers)
    OR (SELECT count(*) FROM jsonb_object_keys(mapping))<>jsonb_array_length(headers) THEN RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  FOR cell IN SELECT * FROM jsonb_array_elements(headers) LOOP
    IF jsonb_typeof(cell)<>'string' OR length(btrim(cell#>>'{}')) NOT BETWEEN 1 AND 80 OR (cell#>>'{}') ~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]'
      OR (cell#>>'{}') ~ '^[[:space:]]*[=+@-]' OR NOT mapping ? (cell#>>'{}') OR jsonb_typeof(mapping->(cell#>>'{}'))<>'string' THEN
      RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT array_agg(v) INTO fields FROM jsonb_each_text(mapping) x(k,v) WHERE v<>'ignore';
  IF EXISTS(SELECT 1 FROM jsonb_each_text(mapping) x(k,v) WHERE v<>'ignore' AND v<>ALL(hon.history_import_fields(v_kind)))
    OR fields IS NULL OR cardinality(fields)<>(SELECT count(DISTINCT x) FROM unnest(fields) x)
    OR NOT hon.history_import_required(v_kind)<@fields THEN RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT timezone INTO tz FROM hon.schools WHERE id=school AND organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(clock_timestamp(),tz);

  FOR item IN SELECT * FROM jsonb_array_elements(rows) LOOP
    idx:=idx+1; checked:=hon.history_import_check_row(v_kind,headers,mapping,item,today);
    n:=checked->'normalized'; errs:=checked->'errors'; profile:=NULL;
    IF v_kind='ATTENDANCE' THEN
      -- Exact names (case-insensitive) at this school, narrowed by birth date when the row gives a valid one. Never a guess.
      IF coalesce(n->>'studentGivenName','')<>'' AND coalesce(n->>'studentFamilyName','')<>'' THEN
        SELECT array_agg(sp.id ORDER BY sp.id) INTO matches FROM hon.student_profiles sp
          JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
          WHERE sp.organization_id=org AND sp.school_id=school
            AND lower(p.given_name)=lower(n->>'studentGivenName') AND lower(p.family_name)=lower(n->>'studentFamilyName')
            AND (n->>'birthDate'='' OR errs ? 'birthDate:USE_YYYY_MM_DD' OR errs ? 'birthDate:OUT_OF_RANGE' OR to_char(sp.birth_date,'YYYY-MM-DD')=n->>'birthDate');
        IF matches IS NULL THEN errs:=errs||'["student:NOT_FOUND"]'::jsonb;
        ELSIF cardinality(matches)>1 THEN errs:=errs||'["student:AMBIGUOUS"]'::jsonb;
        ELSE profile:=matches[1]; END IF;
      END IF;
      IF profile IS NOT NULL AND NOT errs ? 'attendedOn:USE_YYYY_MM_DD' AND n->>'attendedOn'<>'' THEN
        sig:=profile::text||'|'||(n->>'attendedOn')||'|'||lower(n->>'className');
        IF seen ? sig THEN errs:=errs||'["row:REPEATED_IN_FILE"]'::jsonb; ELSE seen:=seen||jsonb_build_object(sig,idx); END IF;
        IF EXISTS(SELECT 1 FROM hon.imported_attendance_history h WHERE h.organization_id=org AND h.school_id=school AND h.student_profile_id=profile
            AND h.attended_on=hon.history_import_date(n->>'attendedOn') AND lower(coalesce(h.class_name,''))=lower(n->>'className')) THEN
          errs:=errs||'["row:ALREADY_IMPORTED"]'::jsonb; END IF;
      END IF;
    ELSE
      IF coalesce(n->>'className','')<>'' THEN
        sig:=lower(n->>'className')||'|'||coalesce(n->>'weekdays','')||'|'||coalesce(n->>'startTime','');
        IF seen ? sig THEN errs:=errs||'["row:REPEATED_IN_FILE"]'::jsonb; ELSE seen:=seen||jsonb_build_object(sig,idx); END IF;
        IF hon.history_import_class_exists(n) THEN errs:=errs||'["className:ALREADY_SCHEDULED"]'::jsonb; END IF;
      END IF;
      -- A program of the same name that was cancelled cannot be reused or recreated under that exact name.
      IF coalesce(n->>'programName','')<>'' AND NOT EXISTS(SELECT 1 FROM hon.programs g WHERE g.organization_id=org AND g.school_id=school
          AND lower(g.name)=lower(n->>'programName') AND g.status<>'CANCELLED')
        AND EXISTS(SELECT 1 FROM hon.programs g WHERE g.organization_id=org AND g.school_id=school AND g.name=n->>'programName') THEN
        errs:=errs||'["programName:CANCELLED_PROGRAM"]'::jsonb; END IF;
    END IF;
    IF errs='[]'::jsonb THEN valid:=valid+1; END IF;
    staged:=staged||jsonb_build_array(jsonb_build_object('index',idx,'sourceRow',checked->'sourceRow','normalized',n,'errors',errs,'profile',profile));
  END LOOP;
  INSERT INTO hon.history_import_batches(organization_id,school_id,kind,source_checksum,headers,mapping,row_count,valid_count,school_today,created_by_principal_id)
    VALUES(org,school,v_kind,encode(sha256(convert_to(p_input->>'csv','UTF8')),'hex'),headers,mapping,jsonb_array_length(rows),valid,today,s.actor) RETURNING * INTO b;
  INSERT INTO hon.history_import_rows(batch_id,organization_id,school_id,row_index,source_row,normalized,validation_errors,matched_profile_id)
    SELECT b.id,org,school,(t->>'index')::integer,t->'sourceRow',t->'normalized',t->'errors',(t->>'profile')::uuid FROM jsonb_array_elements(staged) t;
  RETURN hon.history_import_finish(p_subject,v_kind,s.actor,'stage',b.id,p_key,p_request,p_correlation,hon.history_import_summary(b.id));
END $$;

-- Input: exactly {batchId, expectedVersion, decisions:[{index, choice}]}. IMPORT is accepted only for a row without errors.
CREATE FUNCTION hon.decide_history_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; v_kind text; b hon.history_import_batches%ROWTYPE; item jsonb; v_choice text; idx integer;
BEGIN
  v_kind:=hon.history_import_batch_kind(p_subject,p_input);
  SELECT * INTO s FROM hon.history_import_begin(p_subject,v_kind,'decide',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['batchId','decisions','expectedVersion']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'decisions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'decisions') NOT BETWEEN 1 AND 1000
    OR (SELECT count(DISTINCT d->>'index') FROM jsonb_array_elements(p_input->'decisions') d)<>jsonb_array_length(p_input->'decisions') THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.history_import_batches WHERE id=(p_input->>'batchId')::uuid AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.status<>'STAGED' OR b.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_input->'decisions') LOOP
    IF jsonb_typeof(item)<>'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(item) x) IS DISTINCT FROM ARRAY['choice','index']
      OR jsonb_typeof(item->'index') IS DISTINCT FROM 'number' OR (item->>'index') !~ '^[1-9][0-9]{0,3}$' OR item->>'choice' IS NULL OR item->>'choice' NOT IN ('IMPORT','SKIP') THEN
      RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
    idx:=(item->>'index')::integer; v_choice:=item->>'choice';
    UPDATE hon.history_import_rows SET choice=v_choice WHERE batch_id=b.id AND row_index=idx AND series_id IS NULL AND history_id IS NULL
      AND (v_choice='SKIP' OR validation_errors='[]'::jsonb);
    IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_IMPORT_ROW_NOT_IMPORTABLE' USING ERRCODE='22023'; END IF;
  END LOOP;
  UPDATE hon.history_import_batches SET version=version+1 WHERE id=b.id;
  RETURN hon.history_import_finish(p_subject,v_kind,s.actor,'decide',b.id,p_key,p_request,p_correlation,hon.history_import_summary(b.id));
END $$;

-- One IMPORT row. CLASSES: the program by name (or a new DRAFT one, shared with later rows of this batch), then one
-- ACTIVE weekly series with no sessions. ATTENDANCE: one history row for the matched student. INSERT only.
CREATE FUNCTION hon.apply_history_import_row(p_batch uuid,p_kind text,p_row integer,p_actor uuid,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); r hon.history_import_rows%ROWTYPE; n jsonb;
  program uuid; series uuid; hist uuid; payload jsonb; entity uuid; entity_type text;
BEGIN
  SELECT * INTO r FROM hon.history_import_rows WHERE batch_id=p_batch AND row_index=p_row AND choice='IMPORT' AND validation_errors='[]'::jsonb
    AND series_id IS NULL AND history_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_IMPORT_ROW_NOT_IMPORTABLE' USING ERRCODE='40001'; END IF;
  n:=r.normalized;
  IF p_kind='CLASSES' THEN
    -- Re-checked at finalize: a class of this name may have been scheduled since staging.
    IF hon.history_import_class_exists(n) THEN RAISE EXCEPTION 'HISTORY_IMPORT_STALE' USING ERRCODE='40001'; END IF;
    SELECT g.id INTO program FROM hon.programs g WHERE g.organization_id=org AND g.school_id=school AND lower(g.name)=lower(n->>'programName') AND g.status<>'CANCELLED'
      ORDER BY g.created_at,g.id LIMIT 1;
    IF program IS NULL THEN
      INSERT INTO hon.programs(organization_id,school_id,name) VALUES(org,school,n->>'programName') RETURNING id INTO program;
    END IF;
    INSERT INTO hon.class_series(organization_id,school_id,program_id,name,room_name,capacity,booking_policy,weekdays,local_start_time,duration_minutes,starts_on,actor_principal_id)
      VALUES(org,school,program,n->>'className',nullif(n->>'roomName',''),(n->>'capacity')::integer,n->>'bookingPolicy',
        string_to_array(n->>'weekdays',',')::smallint[],(n->>'startTime')::time,(n->>'durationMinutes')::integer,hon.history_import_date(n->>'startsOn'),p_actor)
      RETURNING id INTO series;
    UPDATE hon.history_import_rows SET program_id=program,series_id=series WHERE batch_id=p_batch AND row_index=p_row;
    entity:=series; entity_type:='CLASS_SERIES';
    payload:=jsonb_build_object('batchId',p_batch,'rowIndex',p_row,'programId',program,'seriesId',series,'internalOnly',true);
  ELSE
    -- Re-checked at finalize: another batch may have imported the same visit since staging.
    IF EXISTS(SELECT 1 FROM hon.imported_attendance_history h WHERE h.organization_id=org AND h.school_id=school AND h.student_profile_id=r.matched_profile_id
        AND h.attended_on=hon.history_import_date(n->>'attendedOn') AND lower(coalesce(h.class_name,''))=lower(n->>'className')) THEN
      RAISE EXCEPTION 'HISTORY_IMPORT_STALE' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.imported_attendance_history(organization_id,school_id,student_profile_id,attended_on,visit_count,class_name,batch_id,row_index)
      VALUES(org,school,r.matched_profile_id,hon.history_import_date(n->>'attendedOn'),(n->>'visits')::integer,nullif(n->>'className',''),p_batch,p_row)
      RETURNING id INTO hist;
    UPDATE hon.history_import_rows SET history_id=hist WHERE batch_id=p_batch AND row_index=p_row;
    entity:=r.matched_profile_id; entity_type:='STUDENT_PROFILE';
    payload:=jsonb_build_object('batchId',p_batch,'rowIndex',p_row,'historyId',hist,'studentProfileId',r.matched_profile_id,'internalOnly',true);
  END IF;
  -- Identifiers only: never a name, class name, date or count in audit or outbox. Deliberately not a "series created" or
  -- "attendance recorded" event, so nothing downstream treats an imported row as live activity.
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','history.import.row_applied',entity_type,entity,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'history.import.row_applied',1,entity_type,entity,1,p_correlation,p_request,payload);
END $$;

-- Input: exactly {batchId, expectedVersion, selectedIndices}. Every row must be decided, and the selection must equal
-- exactly the IMPORT rows, so nothing is imported that staff did not choose on this version.
CREATE FUNCTION hon.finalize_history_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; v_kind text; b hon.history_import_batches%ROWTYPE; sel jsonb; expected jsonb; idx integer;
BEGIN
  v_kind:=hon.history_import_batch_kind(p_subject,p_input);
  SELECT * INTO s FROM hon.history_import_begin(p_subject,v_kind,'finalize',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['batchId','expectedVersion','selectedIndices']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'selectedIndices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'selectedIndices')>1000
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'selectedIndices') x WHERE jsonb_typeof(x)<>'number' OR (x#>>'{}') !~ '^[1-9][0-9]{0,3}$')
    OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_input->'selectedIndices') x)<>jsonb_array_length(p_input->'selectedIndices') THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.history_import_batches WHERE id=(p_input->>'batchId')::uuid AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.status<>'STAGED' OR b.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  SELECT coalesce(jsonb_agg(row_index ORDER BY row_index),'[]'::jsonb) INTO expected FROM hon.history_import_rows WHERE batch_id=b.id AND choice='IMPORT';
  SELECT coalesce(jsonb_agg(x ORDER BY (x#>>'{}')::integer),'[]'::jsonb) INTO sel FROM jsonb_array_elements(p_input->'selectedIndices') x;
  IF sel<>expected OR EXISTS(SELECT 1 FROM hon.history_import_rows WHERE batch_id=b.id AND choice IS NULL) THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_SELECTION_REQUIRED' USING ERRCODE='40001'; END IF;
  -- One finalize of each kind at a time per school, so two batches cannot both schedule the same class or both import
  -- the same visits; each row is then re-checked against what is already there.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.history_import.'||lower(v_kind)||':'||school::text,0));
  FOR idx IN SELECT row_index FROM hon.history_import_rows WHERE batch_id=b.id AND choice='IMPORT' ORDER BY row_index LOOP
    PERFORM hon.apply_history_import_row(b.id,v_kind,idx,s.actor,p_request,p_correlation);
  END LOOP;
  UPDATE hon.history_import_batches SET version=version+1,status='FINALIZED',finalized_at=clock_timestamp(),finalized_by_principal_id=s.actor WHERE id=b.id;
  RETURN hon.history_import_finish(p_subject,v_kind,s.actor,'finalize',b.id,p_key,p_request,p_correlation,hon.history_import_summary(b.id));
END $$;

-- Reads need the same live import authority as the commands (rows hold student names). The list carries the 25 most
-- recent batches and the field lists; a detail read is one batch with its rows.
CREATE FUNCTION hon.read_history_imports(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  PERFORM hon.require_history_import_actor(p_subject,'ANY');
  SELECT jsonb_build_object('batches',coalesce(jsonb_agg(hon.history_import_summary(x.id) ORDER BY x.created_at DESC,x.id),'[]'::jsonb),
    'fields',jsonb_build_object('CLASSES',to_jsonb(hon.history_import_fields('CLASSES')),'ATTENDANCE',to_jsonb(hon.history_import_fields('ATTENDANCE'))),
    'maxBytes',262144,'maxRows',1000,'maxColumns',24) INTO result
  FROM (SELECT id,created_at FROM hon.history_import_batches WHERE organization_id=org AND school_id=school ORDER BY created_at DESC,id LIMIT 25) x;
  RETURN result;
END $$;

CREATE FUNCTION hon.read_history_import(p_subject text,p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_history_import_actor(p_subject,'ANY');
  IF p_batch IS NULL OR NOT EXISTS(SELECT 1 FROM hon.history_import_batches WHERE id=p_batch AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.history_import_detail(p_batch);
END $$;

-- One student's imported history: totals and the most recent 100 rows.
CREATE FUNCTION hon.read_imported_attendance(p_subject text,p_profile uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_history_import_actor(p_subject,'ANY');
  IF p_profile IS NULL OR NOT EXISTS(SELECT 1 FROM hon.student_profiles WHERE id=p_profile AND organization_id=org AND school_id=school) THEN
    RAISE EXCEPTION 'HISTORY_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN (SELECT jsonb_build_object('studentProfileId',p_profile,'totalVisits',coalesce(sum(h.visit_count),0)::integer,
    'firstOn',to_char(min(h.attended_on),'YYYY-MM-DD'),'lastOn',to_char(max(h.attended_on),'YYYY-MM-DD'),
    'entries',coalesce((SELECT jsonb_agg(jsonb_build_object('attendedOn',to_char(e.attended_on,'YYYY-MM-DD'),'visits',e.visit_count,'className',e.class_name,'batchId',e.batch_id)
      ORDER BY e.attended_on DESC,e.id) FROM (SELECT * FROM hon.imported_attendance_history x WHERE x.organization_id=org AND x.school_id=school AND x.student_profile_id=p_profile
      ORDER BY x.attended_on DESC,x.id LIMIT 100) e),'[]'::jsonb))
    FROM hon.imported_attendance_history h WHERE h.organization_id=org AND h.school_id=school AND h.student_profile_id=p_profile);
END $$;

-- Deny first, then exactly the six entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['history_import_batches','history_import_rows','history_import_requests','imported_attendance_history'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_history_import()','hon.require_history_import_actor(text,text)','hon.history_import_fields(text)',
    'hon.history_import_required(text)','hon.history_import_date(text)','hon.history_import_weekdays(text)','hon.history_import_time(text)',
    'hon.history_import_check_row(text,jsonb,jsonb,jsonb,date)','hon.history_import_summary(uuid)','hon.history_import_detail(uuid)',
    'hon.history_import_begin(text,text,text,jsonb,text,uuid,uuid)','hon.history_import_finish(text,text,uuid,text,uuid,text,uuid,uuid,jsonb)',
    'hon.history_import_class_exists(jsonb)','hon.history_import_batch_kind(text,jsonb)','hon.stage_history_import(text,jsonb,text,uuid,uuid)','hon.decide_history_import(text,jsonb,text,uuid,uuid)',
    'hon.apply_history_import_row(uuid,text,integer,uuid,uuid,uuid)','hon.finalize_history_import(text,jsonb,text,uuid,uuid)',
    'hon.read_history_imports(text)','hon.read_history_import(text,uuid)','hon.read_imported_attendance(text,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.stage_history_import(text,jsonb,text,uuid,uuid),hon.decide_history_import(text,jsonb,text,uuid,uuid),
      hon.finalize_history_import(text,jsonb,text,uuid,uuid),hon.read_history_imports(text),hon.read_history_import(text,uuid),
      hon.read_imported_attendance(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
