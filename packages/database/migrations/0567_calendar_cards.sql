BEGIN;

-- 0567 calendar cards (owner David 2026-11-19, number assigned by the coordinator): "i need this calendar to be clickable and
-- let me make schedule or class cards that can be drag and dropped". Spec: docs/architecture/CALENDAR_CARDS_DRAG_AND_DROP.md.
--   K1  Every class session and roster (0239 class series) has a card kind: CLASS (default, every existing row), PRIVATE_LESSON,
--       TRIAL or EVENT. It is a label only; booking, attendance and capacity rules do not change.
--   K2  A roster may name a lead instructor. Every session a roster creates (create, fill, ongoing top-up) gets the roster's
--       kind, and its instructor while that person is still eligible staff at the school.
--   C1  hon.create_calendar_card: one direct human command creates one class, or a roster with its classes through 84 days
--       ahead, all or nothing, with the kind and an optional lead instructor.
--   M1  hon.move_calendar_card: one direct human command moves or resizes one SCHEDULED class that has not started and has no
--       attendance, to a future start, 5-600 minutes long, at the version the page read. A class of a roster is detached from
--       the roster pattern, so a later roster change never moves it back (class_series_apply_future skips it).
--   R1  hon.read_school_calendar_cards: kind, program, roster, lead instructor and booked count of the classes in up to 42
--       school-local days, and, for managers, the pickable programs and instructors (id and display name only).
-- Manage = live schedule.session.manage (0239 actor rule); read = schedule.session.read (0147 actor rule). Nothing contacts a
-- family, charges anyone, or runs on a timer. The runtime gains EXECUTE on three entry points only, and still has no UPDATE on
-- hon.class_sessions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Calendar cards require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.class_series_fill_dates(hon.class_series,date,date)') IS NULL
    OR to_regprocedure('hon.class_series_command_begin(text,text,text)') IS NULL
    OR to_regprocedure('hon.require_current_school_class_sessions_read_actor(text)') IS NULL
    OR to_regprocedure('hon.staff_shift_display_name(uuid)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Calendar cards require 0077, 0147, 0239, 0251 and 0467';
  END IF;
  IF to_regclass('hon.class_session_roster_detachments') IS NOT NULL THEN RAISE EXCEPTION 'Calendar cards already applied'; END IF;
END $$;

-- K1/K2 columns.
ALTER TABLE hon.class_sessions ADD COLUMN session_kind text NOT NULL DEFAULT 'CLASS';
ALTER TABLE hon.class_sessions ADD CONSTRAINT class_sessions_session_kind_check CHECK (session_kind IN ('CLASS','PRIVATE_LESSON','TRIAL','EVENT'));
ALTER TABLE hon.class_series ADD COLUMN session_kind text NOT NULL DEFAULT 'CLASS';
ALTER TABLE hon.class_series ADD CONSTRAINT class_series_session_kind_check CHECK (session_kind IN ('CLASS','PRIVATE_LESSON','TRIAL','EVENT'));
ALTER TABLE hon.class_series ADD COLUMN lead_instructor_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT;

-- M1: a roster class moved on its own. Never rewritten or deleted.
CREATE TABLE hon.class_session_roster_detachments (
  class_session_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  series_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  detached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (class_session_id,organization_id,school_id) REFERENCES hon.class_sessions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (series_id,organization_id,school_id) REFERENCES hon.class_series(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.class_session_roster_detachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_session_roster_detachments FORCE ROW LEVEL SECURITY;
CREATE TRIGGER class_session_roster_detachments_immutable BEFORE UPDATE OR DELETE ON hon.class_session_roster_detachments FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER class_session_roster_detachments_no_truncate BEFORE TRUNCATE ON hon.class_session_roster_detachments FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- An active, eligible human staff member of this school with a live role grant here (the 0467 staff list rule).
CREATE FUNCTION hon.calendar_instructor_ok(p_principal uuid,org uuid,school uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT p_principal IS NOT NULL AND EXISTS(SELECT 1 FROM hon.principals p WHERE p.id=p_principal AND p.principal_type='HUMAN_USER' AND p.is_active
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school
      AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school))
$$;

-- K2: a session a roster just produced takes the roster's kind and, while still eligible, its lead instructor.
CREATE FUNCTION hon.class_series_occurrence_inherit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.class_series%ROWTYPE;
BEGIN
  SELECT * INTO x FROM hon.class_series s WHERE s.id=NEW.series_id AND s.organization_id=NEW.organization_id AND s.school_id=NEW.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASS_SERIES_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF x.session_kind<>'CLASS' THEN
    UPDATE hon.class_sessions SET session_kind=x.session_kind
      WHERE id=NEW.class_session_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id;
  END IF;
  IF x.lead_instructor_principal_id IS NOT NULL AND hon.calendar_instructor_ok(x.lead_instructor_principal_id,NEW.organization_id,NEW.school_id) THEN
    INSERT INTO hon.class_session_instructors(organization_id,school_id,class_session_id,principal_id,assignment_role)
      VALUES(NEW.organization_id,NEW.school_id,NEW.class_session_id,x.lead_instructor_principal_id,'LEAD')
      ON CONFLICT (class_session_id,principal_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER class_series_occurrence_inherit AFTER INSERT ON hon.class_series_occurrences FOR EACH ROW EXECUTE FUNCTION hon.class_series_occurrence_inherit();

-- 0239 S3 with one change: a class moved on its own (M1) is never brought back in line with the roster pattern.
CREATE OR REPLACE FUNCTION hon.class_series_apply_future(x hon.class_series,reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE tz text; o record; starts timestamptz; updated integer:=0; cancelled integer:=0; kept integer:=0;
BEGIN
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=x.school_id AND s.organization_id=x.organization_id;
  FOR o IN SELECT oc.local_date,cs.id session_id
    FROM hon.class_series_occurrences oc JOIN hon.class_sessions cs ON cs.id=oc.class_session_id
    WHERE oc.series_id=x.id AND cs.status='SCHEDULED' AND cs.starts_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM hon.class_session_roster_detachments d WHERE d.class_session_id=cs.id)
    ORDER BY oc.local_date FOR UPDATE OF cs LOOP
    -- Checked in its own statement after the row lock: bookings (0118) and attendance (0115) lock the session and insert
    -- without updating it, so a result computed in the locking query could still miss one that committed while we waited.
    IF EXISTS(SELECT 1 FROM hon.class_bookings b WHERE b.class_session_id=o.session_id AND b.status<>'CANCELLED')
      OR EXISTS(SELECT 1 FROM hon.attendance_records a WHERE a.class_session_id=o.session_id) THEN kept:=kept+1; CONTINUE; END IF;
    -- A move (M1) that committed while we waited for the lock detaches the class too.
    IF EXISTS(SELECT 1 FROM hon.class_session_roster_detachments d WHERE d.class_session_id=o.session_id) THEN CONTINUE; END IF;
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

-- Audit, outbox and the stored replay of one calendar command, then authority once more after the last write.
CREATE FUNCTION hon.calendar_card_command_finish(subject text,key text,actor uuid,result jsonb,action text,entity_type text,entity uuid,
  prior_state jsonb,next_state jsonb,event text,aggregate_version integer,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity_type,entity,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event,1,entity_type,entity,aggregate_version,correlation,request,next_state);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- C1: create one class, or a roster and its classes through 84 days ahead.
CREATE FUNCTION hon.create_calendar_card(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  pattern jsonb; first_day date; last_day date; today date; tz text; starts timestamptz; kind text; instructor uuid; repeats boolean;
  s hon.class_sessions%ROWTYPE; x hon.class_series%ROWTYPE; fill jsonb; first_session uuid; result jsonb; next_state jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['kind','programId','name','capacity','bookingPolicy','localDate','localStartTime','durationMinutes']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('kind','programId','name','roomName','capacity','bookingPolicy','instructorPrincipalId',
      'localDate','localStartTime','durationMinutes','repeatWeekdays','repeatUntil'))
    OR jsonb_typeof(p->'kind') IS DISTINCT FROM 'string' OR p->>'kind' NOT IN ('CLASS','PRIVATE_LESSON','TRIAL','EVENT')
    OR (p ? 'instructorPrincipalId' AND p->'instructorPrincipalId'<>'null'::jsonb AND (jsonb_typeof(p->'instructorPrincipalId')<>'string'
      OR p->>'instructorPrincipalId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR jsonb_typeof(p->'localDate') IS DISTINCT FROM 'string'
    OR (p ? 'repeatWeekdays' AND p->'repeatWeekdays'<>'null'::jsonb AND jsonb_typeof(p->'repeatWeekdays')<>'array')
    OR (p ? 'repeatUntil' AND p->'repeatUntil'<>'null'::jsonb AND (jsonb_typeof(p->'repeatUntil')<>'string'
      OR NOT (p ? 'repeatWeekdays') OR p->'repeatWeekdays'='null'::jsonb))
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  first_day:=hon.membership_pause_date(p->'localDate');
  repeats:=p ? 'repeatWeekdays' AND p->'repeatWeekdays'<>'null'::jsonb;
  -- The shared 0239 pattern rules check the name, room, capacity, booking, weekdays, start time and length.
  pattern:=jsonb_strip_nulls(jsonb_build_object('programId',p->'programId','name',p->'name','roomName',p->'roomName','capacity',p->'capacity',
    'bookingPolicy',p->'bookingPolicy','weekdays',CASE WHEN repeats THEN p->'repeatWeekdays' ELSE jsonb_build_array(extract(isodow FROM first_day)::integer) END,
    'localStartTime',p->'localStartTime','durationMinutes',p->'durationMinutes','startsOn',p->'localDate','endsOn',p->'repeatUntil'));
  IF hon.class_series_pattern(pattern,false) IS NULL
    OR NOT (pattern->'weekdays' @> jsonb_build_array(extract(isodow FROM first_day)::integer)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'repeatUntil' AND p->'repeatUntil'<>'null'::jsonb THEN last_day:=hon.membership_pause_date(p->'repeatUntil');
    IF last_day<first_day THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF; END IF;
  kind:=p->>'kind';
  instructor:=CASE WHEN p ? 'instructorPrincipalId' AND p->'instructorPrincipalId'<>'null'::jsonb THEN (p->>'instructorPrincipalId')::uuid END;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.calendar.create','input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=(p->>'programId')::uuid AND g.organization_id=org AND g.school_id=school AND g.status<>'CANCELLED') THEN
    RAISE EXCEPTION 'PROGRAM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF instructor IS NOT NULL AND NOT hon.calendar_instructor_ok(instructor,org,school) THEN
    RAISE EXCEPTION 'INSTRUCTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  today:=hon.membership_school_today();
  IF first_day<today OR first_day>today+366 THEN RAISE EXCEPTION 'CALENDAR_CARD_NOT_IN_FUTURE' USING ERRCODE='22023'; END IF;
  SELECT sc.timezone INTO tz FROM hon.schools sc WHERE sc.id=school AND sc.organization_id=org;
  IF NOT repeats THEN
    starts:=(first_day+(p->>'localStartTime')::time) AT TIME ZONE tz;
    IF (starts AT TIME ZONE tz)::time<>(p->>'localStartTime')::time OR (starts AT TIME ZONE tz)::date<>first_day THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    IF starts<=clock_timestamp() THEN RAISE EXCEPTION 'CALENDAR_CARD_NOT_IN_FUTURE' USING ERRCODE='22023'; END IF;
    INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status,session_kind)
      VALUES(org,school,(p->>'programId')::uuid,p->>'name',nullif(p->>'roomName',''),starts,starts+make_interval(mins=>(p->>'durationMinutes')::integer),
        (p->>'capacity')::integer,p->>'bookingPolicy','SCHEDULED',kind)
      RETURNING * INTO s;
    IF instructor IS NOT NULL THEN
      INSERT INTO hon.class_session_instructors(organization_id,school_id,class_session_id,principal_id,assignment_role) VALUES(org,school,s.id,instructor,'LEAD');
    END IF;
    result:=jsonb_build_object('repeats',false,'sessionKind',kind,'sessionId',s.id,'seriesId',NULL,'created',1,'skippedDates','[]'::jsonb);
    next_state:=jsonb_build_object('classSessionId',s.id,'programId',s.program_id,'sessionKind',kind,'instructorPrincipalId',instructor,
      'startsAt',hon.saas_ts(s.starts_at),'endsAt',hon.saas_ts(s.ends_at),'version',s.version);
    PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.create','CLASS_SESSION',s.id,NULL,next_state,
      'class_session.created',s.version,request,correlation);
  ELSE
    INSERT INTO hon.class_series(organization_id,school_id,program_id,name,room_name,capacity,booking_policy,weekdays,local_start_time,duration_minutes,
        starts_on,ends_on,actor_principal_id,session_kind,lead_instructor_principal_id)
      VALUES(org,school,(p->>'programId')::uuid,p->>'name',nullif(p->>'roomName',''),(p->>'capacity')::integer,p->>'bookingPolicy',
        ARRAY(SELECT d::text::smallint FROM jsonb_array_elements(pattern->'weekdays') d ORDER BY 1),(p->>'localStartTime')::time,(p->>'durationMinutes')::integer,
        first_day,last_day,actor,kind,instructor)
      RETURNING * INTO x;
    fill:=hon.class_series_fill_dates(x,first_day,today+84);
    UPDATE hon.class_series SET generated_through=today+84,version=version+1,updated_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x;
    SELECT o.class_session_id INTO first_session FROM hon.class_series_occurrences o WHERE o.series_id=x.id ORDER BY o.local_date LIMIT 1;
    result:=jsonb_build_object('repeats',true,'sessionKind',kind,'sessionId',first_session,'seriesId',x.id,'created',(fill->>'created')::integer,
      'skippedDates',fill->'skippedDates');
    next_state:=hon.class_series_json(x)||jsonb_build_object('sessionKind',kind,'instructorPrincipalId',instructor,'created',(fill->>'created')::integer);
    PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.create','CLASS_SERIES',x.id,NULL,next_state,
      'schedule.series.created',x.version,request,correlation);
  END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- M1: move or resize one class.
CREATE FUNCTION hon.move_calendar_card(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  new_start timestamptz; new_end timestamptz; s hon.class_sessions%ROWTYPE; roster uuid; detached boolean:=false; prior jsonb; result jsonb;
  instant text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?Z$';
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','startsAt','endsAt']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','startsAt','endsAt'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'startsAt') IS DISTINCT FROM 'string' OR p->>'startsAt' !~ instant
    OR jsonb_typeof(p->'endsAt') IS DISTINCT FROM 'string' OR p->>'endsAt' !~ instant
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  BEGIN new_start:=(p->>'startsAt')::timestamptz; new_end:=(p->>'endsAt')::timestamptz;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
  IF new_end-new_start<interval '5 minutes' OR new_end-new_start>interval '600 minutes' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.calendar.move','sessionId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO s FROM hon.class_sessions cs WHERE cs.id=selected AND cs.organization_id=org AND cs.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CALENDAR_CARD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF s.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  -- Checked after the row lock, in its own statement (attendance inserts lock the session without updating it).
  IF s.status<>'SCHEDULED' OR s.starts_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM hon.attendance_records a WHERE a.class_session_id=s.id) THEN
    RAISE EXCEPTION 'CALENDAR_CARD_LOCKED' USING ERRCODE='40001'; END IF;
  IF new_start<=clock_timestamp() OR new_start>clock_timestamp()+interval '400 days' THEN RAISE EXCEPTION 'CALENDAR_CARD_NOT_IN_FUTURE' USING ERRCODE='22023'; END IF;
  prior:=jsonb_build_object('classSessionId',s.id,'startsAt',hon.saas_ts(s.starts_at),'endsAt',hon.saas_ts(s.ends_at),'version',s.version);
  UPDATE hon.class_sessions SET starts_at=new_start,ends_at=new_end,version=version+1,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  SELECT o.series_id INTO roster FROM hon.class_series_occurrences o WHERE o.class_session_id=s.id;
  IF roster IS NOT NULL THEN
    INSERT INTO hon.class_session_roster_detachments(class_session_id,organization_id,school_id,series_id,actor_principal_id)
      VALUES(s.id,org,school,roster,actor) ON CONFLICT (class_session_id) DO NOTHING;
    detached:=true;
  END IF;
  result:=jsonb_build_object('sessionId',s.id,'version',s.version,'startsAt',hon.saas_ts(s.starts_at),'endsAt',hon.saas_ts(s.ends_at),'detachedFromRoster',detached);
  PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.move','CLASS_SESSION',s.id,prior,
    jsonb_build_object('classSessionId',s.id,'startsAt',hon.saas_ts(s.starts_at),'endsAt',hon.saas_ts(s.ends_at),'version',s.version,'seriesId',roster,'detachedFromRoster',detached),
    'class_session.rescheduled',s.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- R1: card details of the classes starting in [from, to] school-local days (at most 42 days, 1000 classes).
CREATE FUNCTION hon.read_school_calendar_cards(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; from_day date; to_day date; tz text; from_at timestamptz; to_at timestamptz; can_manage boolean:=false;
  total integer; cards jsonb; result jsonb;
BEGIN
  actor:=hon.require_current_school_class_sessions_read_actor(subject);
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['from','to'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('from','to')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  from_day:=hon.membership_pause_date(p->'from'); to_day:=hon.membership_pause_date(p->'to');
  IF to_day<from_day OR to_day-from_day>42 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  BEGIN PERFORM hon.require_class_series_actor(subject); can_manage:=true;
  EXCEPTION WHEN insufficient_privilege THEN can_manage:=false; END;
  SELECT sc.timezone INTO tz FROM hon.schools sc WHERE sc.id=school AND sc.organization_id=org;
  from_at:=from_day::timestamp AT TIME ZONE tz; to_at:=(to_day+1)::timestamp AT TIME ZONE tz;
  SELECT count(*) INTO total FROM hon.class_sessions cs WHERE cs.organization_id=org AND cs.school_id=school AND cs.starts_at>=from_at AND cs.starts_at<to_at;
  SELECT coalesce(jsonb_agg(item ORDER BY starts_at,id),'[]'::jsonb) INTO cards FROM (
    SELECT cs.starts_at,cs.id,jsonb_build_object('sessionId',cs.id,'version',cs.version,'kind',cs.session_kind,'programId',cs.program_id,
      'programName',left(g.name,120),'seriesId',oc.series_id,
      'instructor',(SELECT jsonb_build_object('principalId',i.principal_id,'displayName',hon.staff_shift_display_name(i.principal_id))
        FROM hon.class_session_instructors i WHERE i.class_session_id=cs.id AND i.organization_id=org AND i.school_id=school
        ORDER BY (i.assignment_role='LEAD') DESC,i.created_at,i.id LIMIT 1),
      'booked',(SELECT count(*) FROM hon.class_bookings b WHERE b.class_session_id=cs.id AND b.status IN ('BOOKED','CHECKED_IN'))::integer,
      'attended',EXISTS(SELECT 1 FROM hon.attendance_records a WHERE a.class_session_id=cs.id)) item
    FROM hon.class_sessions cs JOIN hon.programs g ON g.id=cs.program_id AND g.organization_id=cs.organization_id AND g.school_id=cs.school_id
      LEFT JOIN hon.class_series_occurrences oc ON oc.class_session_id=cs.id
    WHERE cs.organization_id=org AND cs.school_id=school AND cs.starts_at>=from_at AND cs.starts_at<to_at
    ORDER BY cs.starts_at,cs.id LIMIT 1000) t;
  result:=jsonb_build_object('timezone',tz,'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'from',to_char(from_day,'YYYY-MM-DD'),'to',to_char(to_day,'YYYY-MM-DD'),'truncated',total>1000,'canManage',can_manage,'cards',cards,
    'programs',CASE WHEN NOT can_manage THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('programId',g.id,'name',left(g.name,120)) ORDER BY g.name,g.id)
      FROM (SELECT * FROM hon.programs z WHERE z.organization_id=org AND z.school_id=school AND z.status<>'CANCELLED' ORDER BY z.name,z.id LIMIT 200) g),'[]'::jsonb) END,
    'instructors',CASE WHEN NOT can_manage THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('principalId',n.id,'displayName',n.name) ORDER BY n.name,n.id)
      FROM (SELECT p2.id,hon.staff_shift_display_name(p2.id) AS name FROM hon.principals p2
        WHERE p2.principal_type='HUMAN_USER' AND p2.is_active AND hon.calendar_instructor_ok(p2.id,org,school) ORDER BY 2,1 LIMIT 200) n),'[]'::jsonb) END);
  IF hon.require_current_school_class_sessions_read_actor(subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON COLUMN hon.class_sessions.session_kind IS '0567 card kind label (CLASS, PRIVATE_LESSON, TRIAL, EVENT). No booking, attendance or capacity effect.';
COMMENT ON COLUMN hon.class_series.session_kind IS '0567 card kind every session of this roster takes.';
COMMENT ON COLUMN hon.class_series.lead_instructor_principal_id IS '0567 lead instructor every session of this roster takes while still eligible staff.';
COMMENT ON TABLE hon.class_session_roster_detachments IS '0567 roster classes moved on their own; a later roster change never moves them back. Immutable. Private.';
COMMENT ON FUNCTION hon.create_calendar_card(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI calendar create (0567 C1): one class, or a roster and its classes through 84 days ahead, with a kind and an optional lead instructor. No automation, AI, communication or payment effect.';
COMMENT ON FUNCTION hon.move_calendar_card(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI move or resize of one scheduled, unstarted, unattended class (0567 M1); a roster class is detached from the pattern. Families are not contacted.';
COMMENT ON FUNCTION hon.read_school_calendar_cards(text,jsonb) IS
'Direct HUMAN_UI read of card kind, program, roster, lead instructor and booked count for up to 42 school-local days (0567 R1); managers also get programs and instructors (id and name). No DML.';

DO $$ DECLARE r text; col text; f text; fns text[]:=ARRAY['hon.calendar_instructor_ok(uuid,uuid,uuid)','hon.class_series_occurrence_inherit()',
    'hon.class_series_apply_future(hon.class_series,text)',
    'hon.calendar_card_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
    'hon.create_calendar_card(text,jsonb,text,uuid,uuid)','hon.move_calendar_card(text,uuid,jsonb,text,uuid,uuid)','hon.read_school_calendar_cards(text,jsonb)']; BEGIN
  EXECUTE 'REVOKE ALL ON TABLE hon.class_session_roster_detachments FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.class_session_roster_detachments FROM %I',r); END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.class_session_roster_detachments'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.class_session_roster_detachments FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.class_session_roster_detachments FROM %I',col,r); END LOOP;
  END LOOP;
  FOREACH col IN ARRAY ARRAY['session_kind','lead_instructor_principal_id'] LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.class_series FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.class_series FROM %I',col,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_calendar_card(text,jsonb,text,uuid,uuid),hon.move_calendar_card(text,uuid,jsonb,text,uuid,uuid),
      hon.read_school_calendar_cards(text,jsonb) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.class_session_roster_detachments','SELECT,INSERT,UPDATE,DELETE')
      OR has_any_column_privilege('hon_runtime','hon.class_session_roster_detachments','SELECT,INSERT,UPDATE')
      OR has_any_column_privilege('hon_runtime','hon.class_sessions','UPDATE')
      OR has_table_privilege('hon_runtime','hon.class_series','SELECT') OR has_any_column_privilege('hon_runtime','hon.class_series','SELECT,UPDATE')
      OR has_function_privilege('hon_runtime','hon.calendar_instructor_ok(uuid,uuid,uuid)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.calendar_card_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)','EXECUTE')) THEN
    RAISE EXCEPTION 'Calendar cards must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
