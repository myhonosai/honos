BEGIN;

-- B-SCH-1 recurring weekly classes and the weekly timetable (0239, assigned by the coordinator 2026-11-09 under the
-- owner's delegation). Recommended rules put to the owner the same day:
--   S1  A class series is a weekly pattern in SCHOOL time: one program, name, room, capacity, booking policy, one or more
--       weekdays, a local start time, a length in minutes, a first date and an optional last date. Staff with the existing
--       schedule.session.manage permission create, revise and end series.
--   S2  Sessions are created only when a staff member asks ("fill through" a date), never by automation, at most 84 days
--       (12 weeks) past the school-local today. Each series date yields at most one session; a fill repeats safely.
--       A date whose local start time does not exist (daylight-saving gap) is skipped and reported, never shifted.
--   S3  Revising or ending a series changes only its FUTURE sessions that have no booking and no attendance: they take the
--       new name/room/capacity/policy/time, or are cancelled when their date leaves the pattern. A future session that
--       already has a booking or attendance is left exactly as it is and reported, so no student's class moves silently.
--   S4  Staff with schedule.session.read see the school's week (Monday to Sunday, school time) with every session, its
--       series, and how many places are booked.
-- The runtime gains no table privilege: every write goes through a direct-human SECURITY DEFINER command with live
-- school-scoped permission re-checks, exact-request idempotency, audit and an inert outbox event. The runtime still has
-- no UPDATE privilege on hon.class_sessions; the existing one-off session create path is unchanged.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Recurring class series require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Recurring class series require a restricted runtime';
  END IF;
  IF to_regclass('hon.class_sessions') IS NULL OR to_regclass('hon.class_bookings') IS NULL OR to_regclass('hon.attendance_records') IS NULL
    OR to_regprocedure('hon.require_current_school_class_sessions_read_actor(text)') IS NULL
    OR to_regprocedure('hon.membership_school_today()') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.membership_pause_text_ok(jsonb,boolean)') IS NULL OR to_regprocedure('hon.membership_pause_date(jsonb)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='schedule.session.manage') OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='schedule.session.read') THEN
    RAISE EXCEPTION 'Recurring class series require 0032, 0034, 0147, 0177 and 0224';
  END IF;
END $$;

-- S1: one weekly pattern. Immutable identity; every change raises the version by exactly one; ENDED is final.
CREATE TABLE hon.class_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  program_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND btrim(name)=name AND name !~ '[\x01-\x1f\x7f]'),
  room_name text CHECK (room_name IS NULL OR (length(room_name) BETWEEN 1 AND 120 AND btrim(room_name)=room_name AND room_name !~ '[\x01-\x1f\x7f]')),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  booking_policy text NOT NULL CHECK (booking_policy IN ('WALK_IN','OPTIONAL_BOOKING','REQUIRED_BOOKING')),
  weekdays smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND array_ndims(weekdays)=1 AND 1<=ALL(weekdays) AND 7>=ALL(weekdays)),
  local_start_time time NOT NULL CHECK (date_trunc('minute',local_start_time)=local_start_time),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  starts_on date NOT NULL CHECK (starts_on >= DATE '2000-01-01'),
  ends_on date CHECK (ends_on IS NULL OR ends_on >= starts_on),
  generated_through date,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  end_reason text CHECK (end_reason IS NULL OR (length(end_reason) BETWEEN 1 AND 1000 AND btrim(end_reason)=end_reason AND end_reason !~ '[\x01-\x1f\x7f]')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='ENDED')=(end_reason IS NOT NULL) AND (status<>'ENDED' OR ends_on IS NOT NULL)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id)
);
CREATE INDEX class_series_school_idx ON hon.class_series(organization_id,school_id,status,id);
-- S2: the one session a series date produced. Never rewritten or deleted.
CREATE TABLE hon.class_series_occurrences (
  series_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  local_date date NOT NULL,
  class_session_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (series_id,local_date),
  FOREIGN KEY (series_id,organization_id,school_id) REFERENCES hon.class_series(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (class_session_id,organization_id,school_id) REFERENCES hon.class_sessions(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.class_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_series FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.class_series_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_series_occurrences FORCE ROW LEVEL SECURITY;
CREATE TRIGGER class_series_no_truncate BEFORE TRUNCATE ON hon.class_series FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER class_series_occurrences_no_truncate BEFORE TRUNCATE ON hon.class_series_occurrences FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER class_series_occurrences_immutable BEFORE UPDATE OR DELETE ON hon.class_series_occurrences FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();

CREATE FUNCTION hon.guard_class_series() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLASS_SERIES_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'ACTIVE' OR NEW.generated_through IS NOT NULL OR (SELECT count(DISTINCT x) FROM unnest(NEW.weekdays) x)<>cardinality(NEW.weekdays) THEN
      RAISE EXCEPTION 'CLASS_SERIES_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.program_id,NEW.starts_on,NEW.actor_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.program_id,OLD.starts_on,OLD.actor_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 OR OLD.status='ENDED' OR (SELECT count(DISTINCT x) FROM unnest(NEW.weekdays) x)<>cardinality(NEW.weekdays)
    OR (OLD.generated_through IS NOT NULL AND (NEW.generated_through IS NULL OR NEW.generated_through<OLD.generated_through)) THEN
    RAISE EXCEPTION 'CLASS_SERIES_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER class_series_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.class_series FOR EACH ROW EXECUTE FUNCTION hon.guard_class_series();

-- Live direct-human schedule.session.manage at the current school, or a refusal. The identity rules are the 0224/0240 ones,
-- and the entitlement rule is the 0147 one.
CREATE FUNCTION hon.require_class_series_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code='schedule.session.manage')
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.class_series_json(x hon.class_series) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('seriesId',x.id,'programId',x.program_id,'name',x.name,'roomName',x.room_name,'capacity',x.capacity,
    'bookingPolicy',x.booking_policy,'weekdays',to_jsonb(ARRAY(SELECT d FROM unnest(x.weekdays) d ORDER BY d)),
    'localStartTime',to_char(x.local_start_time,'HH24:MI'),'durationMinutes',x.duration_minutes,
    'startsOn',to_char(x.starts_on,'YYYY-MM-DD'),'endsOn',CASE WHEN x.ends_on IS NULL THEN NULL ELSE to_char(x.ends_on,'YYYY-MM-DD') END,
    'generatedThrough',CASE WHEN x.generated_through IS NULL THEN NULL ELSE to_char(x.generated_through,'YYYY-MM-DD') END,
    'status',x.status,'endReason',x.end_reason,'version',x.version,
    'futureSessions',(SELECT count(*) FROM hon.class_series_occurrences o JOIN hon.class_sessions s ON s.id=o.class_session_id
      WHERE o.series_id=x.id AND s.status='SCHEDULED' AND s.starts_at>clock_timestamp())::integer,
    'createdAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- The pattern fields of a create or revise body (closed set); NULL when anything is not acceptable.
CREATE FUNCTION hon.class_series_pattern(p jsonb,revise boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE allowed text[]:=CASE WHEN revise THEN ARRAY['expectedVersion','name','roomName','capacity','bookingPolicy','weekdays','localStartTime','durationMinutes','endsOn']
    ELSE ARRAY['programId','name','roomName','capacity','bookingPolicy','weekdays','localStartTime','durationMinutes','startsOn','endsOn'] END;
  required text[]:=CASE WHEN revise THEN ARRAY['expectedVersion','name','capacity','bookingPolicy','weekdays','localStartTime','durationMinutes']
    ELSE ARRAY['programId','name','capacity','bookingPolicy','weekdays','localStartTime','durationMinutes','startsOn'] END;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& required OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(allowed))
    OR NOT hon.membership_pause_text_ok(p->'name',true) OR length(p->>'name')>120
    OR (p ? 'roomName' AND p->'roomName'<>'null'::jsonb AND (NOT hon.membership_pause_text_ok(p->'roomName',true) OR length(p->>'roomName')>120))
    OR jsonb_typeof(p->'capacity') IS DISTINCT FROM 'number' OR (p->'capacity')::text !~ '^[1-9][0-9]{0,3}$' OR (p->>'capacity')::integer>1000
    OR jsonb_typeof(p->'bookingPolicy') IS DISTINCT FROM 'string' OR p->>'bookingPolicy' NOT IN ('WALK_IN','OPTIONAL_BOOKING','REQUIRED_BOOKING')
    OR jsonb_typeof(p->'weekdays') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'weekdays') NOT BETWEEN 1 AND 7
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'weekdays') d WHERE jsonb_typeof(d)<>'number' OR d::text !~ '^[1-7]$')
    OR (SELECT count(DISTINCT d::text) FROM jsonb_array_elements(p->'weekdays') d)<>jsonb_array_length(p->'weekdays')
    OR jsonb_typeof(p->'localStartTime') IS DISTINCT FROM 'string' OR p->>'localStartTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    OR jsonb_typeof(p->'durationMinutes') IS DISTINCT FROM 'number' OR (p->'durationMinutes')::text !~ '^[1-9][0-9]{0,2}$'
    OR (p->>'durationMinutes')::integer NOT BETWEEN 5 AND 600
    OR (revise AND (jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'))
    OR (NOT revise AND (jsonb_typeof(p->'programId') IS DISTINCT FROM 'string' OR p->>'programId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR (p ? 'endsOn' AND p->'endsOn'<>'null'::jsonb AND jsonb_typeof(p->'endsOn')<>'string') THEN RETURN NULL; END IF;
  RETURN p;
END $$;

-- Shared idempotency: reserve the key, take the IAM SHARE locks, re-check live authority, and return the stored response on
-- an exact replay (after one more authority check). NULL means: proceed with the write.
CREATE FUNCTION hon.class_series_command_begin(subject text,key text,fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN prior.response_body;
END $$;

CREATE FUNCTION hon.class_series_command_finish(subject text,key text,actor uuid,result jsonb,action text,series uuid,
  prior_state jsonb,next_state jsonb,event text,series_version integer,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'CLASS_SERIES',series,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event,1,'CLASS_SERIES',series,series_version,correlation,request,next_state);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- S3: bring the series' future, untouched sessions in line with the (new) pattern; leave booked/attended ones alone.
-- Returns {updated, cancelled, keptBooked}.
CREATE FUNCTION hon.class_series_apply_future(x hon.class_series,reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE tz text; o record; starts timestamptz; updated integer:=0; cancelled integer:=0; kept integer:=0;
BEGIN
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=x.school_id AND s.organization_id=x.organization_id;
  FOR o IN SELECT oc.local_date,cs.id session_id,
      EXISTS(SELECT 1 FROM hon.class_bookings b WHERE b.class_session_id=cs.id AND b.status<>'CANCELLED')
        OR EXISTS(SELECT 1 FROM hon.attendance_records a WHERE a.class_session_id=cs.id) used
    FROM hon.class_series_occurrences oc JOIN hon.class_sessions cs ON cs.id=oc.class_session_id
    WHERE oc.series_id=x.id AND cs.status='SCHEDULED' AND cs.starts_at>clock_timestamp()
    ORDER BY oc.local_date FOR UPDATE OF cs LOOP
    IF o.used THEN kept:=kept+1; CONTINUE; END IF;
    starts:=(o.local_date+x.local_start_time) AT TIME ZONE tz;
    IF (x.ends_on IS NOT NULL AND o.local_date>x.ends_on) OR NOT (extract(isodow FROM o.local_date)::smallint=ANY(x.weekdays))
      OR (starts AT TIME ZONE tz)::time<>x.local_start_time OR starts<=clock_timestamp() THEN
      UPDATE hon.class_sessions SET status='CANCELLED',cancellation_reason=reason,version=version+1,updated_at=clock_timestamp() WHERE id=o.session_id;
      cancelled:=cancelled+1;
    ELSE
      UPDATE hon.class_sessions SET name=x.name,room_name=x.room_name,capacity=x.capacity,booking_policy=x.booking_policy,
          starts_at=starts,ends_at=starts+make_interval(mins=>x.duration_minutes),version=version+1,updated_at=clock_timestamp()
        WHERE id=o.session_id AND (name,room_name,capacity,booking_policy,starts_at,ends_at) IS DISTINCT FROM
          (x.name,x.room_name,x.capacity,x.booking_policy,starts,starts+make_interval(mins=>x.duration_minutes));
      IF FOUND THEN updated:=updated+1; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('updated',updated,'cancelled',cancelled,'keptBooked',kept);
END $$;

-- S1: create one series. No session is created here; filling is its own command (S2).
CREATE FUNCTION hon.create_class_series(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; x hon.class_series%ROWTYPE;
  first_day date; last_day date; result jsonb;
BEGIN
  IF hon.class_series_pattern(p,false) IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  first_day:=hon.membership_pause_date(p->'startsOn');
  IF p ? 'endsOn' AND p->'endsOn'<>'null'::jsonb THEN last_day:=hon.membership_pause_date(p->'endsOn'); END IF;
  IF last_day<first_day THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.series.create','input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=(p->>'programId')::uuid AND g.organization_id=org AND g.school_id=school AND g.status<>'CANCELLED') THEN
    RAISE EXCEPTION 'PROGRAM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF first_day<hon.membership_school_today()-7 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.class_series(organization_id,school_id,program_id,name,room_name,capacity,booking_policy,weekdays,local_start_time,duration_minutes,starts_on,ends_on,actor_principal_id)
    VALUES(org,school,(p->>'programId')::uuid,p->>'name',nullif(p->>'roomName',''),(p->>'capacity')::integer,p->>'bookingPolicy',
      ARRAY(SELECT d::text::smallint FROM jsonb_array_elements(p->'weekdays') d ORDER BY 1),(p->>'localStartTime')::time,(p->>'durationMinutes')::integer,first_day,last_day,actor)
    RETURNING * INTO x;
  result:=jsonb_build_object('series',hon.class_series_json(x),'sessions',jsonb_build_object('created',0,'updated',0,'cancelled',0,'keptBooked',0,'skippedDates','[]'::jsonb));
  PERFORM hon.class_series_command_finish(subject,key,actor,result,'schedule.series.create',x.id,NULL,result->'series','schedule.series.created',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S3: replace the pattern (program and first date stay); future untouched sessions follow, booked ones are kept.
CREATE FUNCTION hon.revise_class_series(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; x hon.class_series%ROWTYPE;
  new_last date; prior jsonb; effect jsonb; result jsonb;
BEGIN
  IF selected IS NULL OR hon.class_series_pattern(p,true) IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'endsOn' AND p->'endsOn'<>'null'::jsonb THEN new_last:=hon.membership_pause_date(p->'endsOn'); END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.series.revise','seriesId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO x FROM hon.class_series s WHERE s.id=selected AND s.organization_id=org AND s.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASS_SERIES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status<>'ACTIVE' THEN RAISE EXCEPTION 'CLASS_SERIES_ENDED' USING ERRCODE='40001'; END IF;
  IF new_last IS NOT NULL AND (new_last<x.starts_on OR new_last<hon.membership_school_today()) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  prior:=hon.class_series_json(x);
  UPDATE hon.class_series SET name=p->>'name',room_name=nullif(p->>'roomName',''),capacity=(p->>'capacity')::integer,booking_policy=p->>'bookingPolicy',
      weekdays=ARRAY(SELECT d::text::smallint FROM jsonb_array_elements(p->'weekdays') d ORDER BY 1),local_start_time=(p->>'localStartTime')::time,
      duration_minutes=(p->>'durationMinutes')::integer,ends_on=new_last,version=version+1,updated_at=clock_timestamp()
    WHERE id=x.id RETURNING * INTO x;
  effect:=hon.class_series_apply_future(x,'The class series changed');
  result:=jsonb_build_object('series',hon.class_series_json(x),'sessions',effect||jsonb_build_object('created',0,'skippedDates','[]'::jsonb));
  PERFORM hon.class_series_command_finish(subject,key,actor,result,'schedule.series.revise',x.id,prior,result,'schedule.series.revised',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S3: end a series on a date (today or later) with a reason; future untouched sessions after it are cancelled.
CREATE FUNCTION hon.end_class_series(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; x hon.class_series%ROWTYPE;
  last_day date; prior jsonb; effect jsonb; result jsonb;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','lastDate','reason']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','lastDate','reason'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_pause_text_ok(p->'reason',true) OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  last_day:=hon.membership_pause_date(p->'lastDate');
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.series.end','seriesId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO x FROM hon.class_series s WHERE s.id=selected AND s.organization_id=org AND s.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASS_SERIES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status<>'ACTIVE' THEN RAISE EXCEPTION 'CLASS_SERIES_ENDED' USING ERRCODE='40001'; END IF;
  IF last_day<hon.membership_school_today()-1 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  prior:=hon.class_series_json(x);
  UPDATE hon.class_series SET ends_on=greatest(last_day,starts_on),status='ENDED',end_reason=p->>'reason',version=version+1,updated_at=clock_timestamp()
    WHERE id=x.id RETURNING * INTO x;
  -- An ended series keeps its sessions up to its last date: only untouched ones after it are cancelled.
  effect:=hon.class_series_apply_future(x,'The class series ended');
  result:=jsonb_build_object('series',hon.class_series_json(x),'sessions',effect||jsonb_build_object('created',0,'skippedDates','[]'::jsonb));
  PERFORM hon.class_series_command_finish(subject,key,actor,result,'schedule.series.end',x.id,prior,result,'schedule.series.ended',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S2: create the missing sessions of an ACTIVE series from the later of its first date and today, through a date at most
-- 84 days past the school-local today (and never past the series' last date). Dates already filled are not touched.
CREATE FUNCTION hon.fill_class_series(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; x hon.class_series%ROWTYPE;
  through date; today date; d date; tz text; starts timestamptz; new_session uuid; created integer:=0; skipped jsonb:='[]'::jsonb; prior jsonb; result jsonb;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','throughDate']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','throughDate'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  through:=hon.membership_pause_date(p->'throughDate');
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.series.fill','seriesId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO x FROM hon.class_series s WHERE s.id=selected AND s.organization_id=org AND s.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASS_SERIES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status<>'ACTIVE' THEN RAISE EXCEPTION 'CLASS_SERIES_ENDED' USING ERRCODE='40001'; END IF;
  today:=hon.membership_school_today();
  IF through<today OR through>today+84 THEN RAISE EXCEPTION 'CLASS_SERIES_FILL_TOO_FAR' USING ERRCODE='22023'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  prior:=hon.class_series_json(x);
  d:=greatest(x.starts_on,today);
  WHILE d<=least(through,coalesce(x.ends_on,through)) LOOP
    IF extract(isodow FROM d)::smallint=ANY(x.weekdays) AND NOT EXISTS(SELECT 1 FROM hon.class_series_occurrences o WHERE o.series_id=x.id AND o.local_date=d) THEN
      starts:=(d+x.local_start_time) AT TIME ZONE tz;
      IF (starts AT TIME ZONE tz)::time<>x.local_start_time OR (starts AT TIME ZONE tz)::date<>d THEN
        skipped:=skipped||to_jsonb(to_char(d,'YYYY-MM-DD'));
      ELSIF starts>clock_timestamp() THEN
        INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status)
          VALUES(org,school,x.program_id,x.name,x.room_name,starts,starts+make_interval(mins=>x.duration_minutes),x.capacity,x.booking_policy,'SCHEDULED')
          RETURNING id INTO new_session;
        INSERT INTO hon.class_series_occurrences(series_id,organization_id,school_id,local_date,class_session_id) VALUES(x.id,org,school,d,new_session);
        created:=created+1;
      END IF;
    END IF;
    d:=d+1;
  END LOOP;
  UPDATE hon.class_series SET generated_through=greatest(coalesce(generated_through,through),through),version=version+1,updated_at=clock_timestamp()
    WHERE id=x.id RETURNING * INTO x;
  result:=jsonb_build_object('series',hon.class_series_json(x),
    'sessions',jsonb_build_object('created',created,'updated',0,'cancelled',0,'keptBooked',0,'skippedDates',skipped));
  PERFORM hon.class_series_command_finish(subject,key,actor,result,'schedule.series.fill',x.id,prior,result,'schedule.series.filled',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Read: the school's series (active first, then ended; at most 200) for staff who manage sessions.
CREATE FUNCTION hon.read_school_class_series(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  result:=jsonb_build_object('localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'timezone',(SELECT s.timezone FROM hon.schools s WHERE s.id=hon.current_school_id()),
    'fillLimit',to_char(hon.membership_school_today()+84,'YYYY-MM-DD'),
    'series',coalesce((SELECT jsonb_agg(hon.class_series_json(x) ORDER BY x.status,x.name,x.id) FROM (SELECT * FROM hon.class_series y
      WHERE y.organization_id=hon.current_organization_id() AND y.school_id=hon.current_school_id() ORDER BY y.status,y.name,y.id LIMIT 200) x),'[]'::jsonb),
    'programs',coalesce((SELECT jsonb_agg(jsonb_build_object('programId',g.id,'name',g.name) ORDER BY g.name,g.id) FROM (SELECT * FROM hon.programs z
      WHERE z.organization_id=hon.current_organization_id() AND z.school_id=hon.current_school_id() AND z.status<>'CANCELLED' ORDER BY z.name,z.id LIMIT 200) g),'[]'::jsonb));
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- S4 read: one school-local week (Monday to Sunday) of the current school's sessions, at most 500, ordered by start then id.
CREATE FUNCTION hon.read_school_weekly_timetable(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; tz text; today date; week date; from_at timestamptz; to_at timestamptz; items jsonb; total integer; result jsonb;
BEGIN
  PERFORM hon.require_current_school_class_sessions_read_actor(subject);
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'weekOf') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  today:=hon.membership_school_today();
  week:=CASE WHEN p ? 'weekOf' THEN hon.membership_pause_date(p->'weekOf') ELSE today END;
  week:=week-(extract(isodow FROM week)::integer-1);
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  from_at:=week::timestamp AT TIME ZONE tz; to_at:=(week+7)::timestamp AT TIME ZONE tz;
  SELECT count(*) INTO total FROM hon.class_sessions cs WHERE cs.organization_id=org AND cs.school_id=school AND cs.starts_at>=from_at AND cs.starts_at<to_at;
  SELECT coalesce(jsonb_agg(item ORDER BY starts_at,id),'[]'::jsonb) INTO items FROM (
    SELECT cs.starts_at,cs.id,jsonb_build_object('sessionId',cs.id,'seriesId',oc.series_id,'name',cs.name,'roomName',cs.room_name,
      'startsAt',to_char(cs.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(cs.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'localDate',to_char(cs.starts_at AT TIME ZONE tz,'YYYY-MM-DD'),'localStart',to_char(cs.starts_at AT TIME ZONE tz,'HH24:MI'),'localEnd',to_char(cs.ends_at AT TIME ZONE tz,'HH24:MI'),
      'capacity',cs.capacity,'bookingPolicy',cs.booking_policy,'status',cs.status::text,
      'booked',(SELECT count(*) FROM hon.class_bookings b WHERE b.class_session_id=cs.id AND b.status IN ('BOOKED','CHECKED_IN'))::integer) item
    FROM hon.class_sessions cs LEFT JOIN hon.class_series_occurrences oc ON oc.class_session_id=cs.id
    WHERE cs.organization_id=org AND cs.school_id=school AND cs.starts_at>=from_at AND cs.starts_at<to_at
    ORDER BY cs.starts_at,cs.id LIMIT 500) t;
  result:=jsonb_build_object('timezone',tz,'localToday',to_char(today,'YYYY-MM-DD'),'weekStart',to_char(week,'YYYY-MM-DD'),
    'weekEnd',to_char(week+6,'YYYY-MM-DD'),'truncated',total>500,'sessions',items);
  PERFORM hon.require_current_school_class_sessions_read_actor(subject);
  RETURN result;
END $$;

COMMENT ON TABLE hon.class_series IS '0239 weekly class patterns in school time (B-SCH-1 S1-S3). Sessions are created only by a staff fill command. Private.';
COMMENT ON TABLE hon.class_series_occurrences IS '0239 the one session each series date produced. Immutable. Private.';
COMMENT ON FUNCTION hon.fill_class_series(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI fill of a weekly class series through a date at most 84 days ahead (B-SCH-1 S2). Idempotent per series date; daylight-saving gaps are skipped and reported. No automation, AI, communication or payment effect.';
COMMENT ON FUNCTION hon.read_school_weekly_timetable(text,jsonb) IS 'Direct HUMAN_UI read-only school-local week of class sessions with booked counts (B-SCH-1 S4). No DML.';

DO $$ DECLARE r text; col text; t text; f text; fns text[]:=ARRAY['hon.guard_class_series()','hon.require_class_series_actor(text)','hon.class_series_json(hon.class_series)',
    'hon.class_series_pattern(jsonb,boolean)','hon.class_series_command_begin(text,text,text)',
    'hon.class_series_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)','hon.class_series_apply_future(hon.class_series,text)',
    'hon.create_class_series(text,jsonb,text,uuid,uuid)','hon.revise_class_series(text,uuid,jsonb,text,uuid,uuid)','hon.end_class_series(text,uuid,jsonb,text,uuid,uuid)',
    'hon.fill_class_series(text,uuid,jsonb,text,uuid,uuid)','hon.read_school_class_series(text)','hon.read_school_weekly_timetable(text,jsonb)']; BEGIN
  FOREACH t IN ARRAY ARRAY['class_series','class_series_occurrences'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_class_series(text,jsonb,text,uuid,uuid),hon.revise_class_series(text,uuid,jsonb,text,uuid,uuid),
      hon.end_class_series(text,uuid,jsonb,text,uuid,uuid),hon.fill_class_series(text,uuid,jsonb,text,uuid,uuid),
      hon.read_school_class_series(text),hon.read_school_weekly_timetable(text,jsonb) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.class_series','SELECT') OR has_any_column_privilege('hon_runtime','hon.class_series','SELECT')
      OR has_table_privilege('hon_runtime','hon.class_series_occurrences','SELECT') OR has_any_column_privilege('hon_runtime','hon.class_sessions','UPDATE')) THEN
    RAISE EXCEPTION 'Recurring class series must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
