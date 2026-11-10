BEGIN;

-- B-SCH-2 ongoing class series (0251, assigned by the coordinator 2026-11-10). The owner chose on 2026-11-10 that some
-- classes should keep their sessions created on an ongoing basis ("Fill automatically each week", behind a switch):
--   O1  Each series has an "ongoing" switch, OFF for every existing and new series. Only staff with the existing
--       schedule.session.manage permission turn it on or off, through a direct human command with the 0239 identity,
--       idempotency, audit and outbox rules. Turning it on also fills the series through 84 days past school-local today.
--   O2  An ongoing ACTIVE series is topped up again to 84 days ahead once fewer than 77 days remain (about once a week).
--       The top-up is its own direct human command, sent by the staff page when a manager opens it and the read says a
--       top-up is due; nothing here runs on a timer. Each top-up continues after the last filled date, so a date skipped
--       for a daylight-saving gap is reported once, and a date already filled is never created twice.
--   O3  Everything else is the 0239 rule: never past the series' last date, booked or attended sessions are never touched,
--       ended series are never topped up, and no family is contacted and nobody is charged.
-- The runtime gains no table privilege; two new direct-human SECURITY DEFINER entry points are its only new grants.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Ongoing class series require a trusted migration owner';
  END IF;
  IF to_regclass('hon.class_series') IS NULL OR to_regprocedure('hon.class_series_command_begin(text,text,text)') IS NULL
    OR to_regprocedure('hon.require_class_series_actor(text)') IS NULL OR to_regprocedure('hon.class_series_json(hon.class_series)') IS NULL THEN
    RAISE EXCEPTION 'Ongoing class series require 0239';
  END IF;
END $$;

ALTER TABLE hon.class_series ADD COLUMN ongoing boolean NOT NULL DEFAULT false;

-- 0239's series JSON plus the switch.
CREATE OR REPLACE FUNCTION hon.class_series_json(x hon.class_series) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('seriesId',x.id,'programId',x.program_id,'name',x.name,'roomName',x.room_name,'capacity',x.capacity,
    'bookingPolicy',x.booking_policy,'weekdays',to_jsonb(ARRAY(SELECT d FROM unnest(x.weekdays) d ORDER BY d)),
    'localStartTime',to_char(x.local_start_time,'HH24:MI'),'durationMinutes',x.duration_minutes,
    'startsOn',to_char(x.starts_on,'YYYY-MM-DD'),'endsOn',CASE WHEN x.ends_on IS NULL THEN NULL ELSE to_char(x.ends_on,'YYYY-MM-DD') END,
    'generatedThrough',CASE WHEN x.generated_through IS NULL THEN NULL ELSE to_char(x.generated_through,'YYYY-MM-DD') END,
    'status',x.status,'endReason',x.end_reason,'version',x.version,'ongoing',x.ongoing,
    'futureSessions',(SELECT count(*) FROM hon.class_series_occurrences o JOIN hon.class_sessions s ON s.id=o.class_session_id
      WHERE o.series_id=x.id AND s.status='SCHEDULED' AND s.starts_at>clock_timestamp())::integer,
    'createdAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- The 0239 S2 fill loop over [from_day, through] (never before today or the first date, never past the last date).
-- The caller holds the series row lock. Returns {created, skippedDates}.
CREATE FUNCTION hon.class_series_fill_dates(x hon.class_series,from_day date,through date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE tz text; d date; starts timestamptz; new_session uuid; created integer:=0; skipped jsonb:='[]'::jsonb;
BEGIN
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=x.school_id AND s.organization_id=x.organization_id;
  d:=greatest(x.starts_on,hon.membership_school_today(),from_day);
  WHILE d<=least(through,coalesce(x.ends_on,through)) LOOP
    IF extract(isodow FROM d)::smallint=ANY(x.weekdays) AND NOT EXISTS(SELECT 1 FROM hon.class_series_occurrences o WHERE o.series_id=x.id AND o.local_date=d) THEN
      starts:=(d+x.local_start_time) AT TIME ZONE tz;
      IF (starts AT TIME ZONE tz)::time<>x.local_start_time OR (starts AT TIME ZONE tz)::date<>d THEN
        skipped:=skipped||to_jsonb(to_char(d,'YYYY-MM-DD'));
      ELSIF starts>clock_timestamp() THEN
        INSERT INTO hon.class_sessions(organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status)
          VALUES(x.organization_id,x.school_id,x.program_id,x.name,x.room_name,starts,starts+make_interval(mins=>x.duration_minutes),x.capacity,x.booking_policy,'SCHEDULED')
          RETURNING id INTO new_session;
        INSERT INTO hon.class_series_occurrences(series_id,organization_id,school_id,local_date,class_session_id) VALUES(x.id,x.organization_id,x.school_id,d,new_session);
        created:=created+1;
      END IF;
    END IF;
    d:=d+1;
  END LOOP;
  RETURN jsonb_build_object('created',created,'skippedDates',skipped);
END $$;

-- O1: turn the switch on (and fill through 84 days ahead) or off. Same body shape as the 0239 commands.
CREATE FUNCTION hon.set_class_series_ongoing(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; x hon.class_series%ROWTYPE;
  through date; filled jsonb:=jsonb_build_object('created',0,'skippedDates','[]'::jsonb); prior jsonb; result jsonb;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','ongoing']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','ongoing'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'ongoing') IS DISTINCT FROM 'boolean' OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.series.ongoing','seriesId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO x FROM hon.class_series s WHERE s.id=selected AND s.organization_id=org AND s.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASS_SERIES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status<>'ACTIVE' THEN RAISE EXCEPTION 'CLASS_SERIES_ENDED' USING ERRCODE='40001'; END IF;
  prior:=hon.class_series_json(x);
  IF (p->>'ongoing')::boolean THEN
    through:=hon.membership_school_today()+84;
    filled:=hon.class_series_fill_dates(x,hon.membership_school_today(),through);
    UPDATE hon.class_series SET ongoing=true,generated_through=greatest(coalesce(generated_through,through),through),version=version+1,updated_at=clock_timestamp()
      WHERE id=x.id RETURNING * INTO x;
  ELSE
    UPDATE hon.class_series SET ongoing=false,version=version+1,updated_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x;
  END IF;
  result:=jsonb_build_object('series',hon.class_series_json(x),
    'sessions',filled||jsonb_build_object('updated',0,'cancelled',0,'keptBooked',0));
  PERFORM hon.class_series_command_finish(subject,key,actor,result,'schedule.series.ongoing',x.id,prior,result,'schedule.series.ongoing_set',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- O2: top up every due ongoing series of the current school (at most 50 per call, in id order) to 84 days ahead.
-- Each series gets its own audit row and outbox event; one idempotency record covers the call.
CREATE FUNCTION hon.top_up_class_series(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; x hon.class_series%ROWTYPE;
  today date; through date; filled jsonb; prior jsonb; next_state jsonb; series_count integer:=0; created integer:=0; skipped jsonb:='[]'::jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p<>'{}'::jsonb OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.series.top_up','input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  today:=hon.membership_school_today(); through:=today+84;
  FOR x IN SELECT * FROM hon.class_series s WHERE s.organization_id=org AND s.school_id=school AND s.status='ACTIVE' AND s.ongoing
      AND (s.generated_through IS NULL OR (s.generated_through<today+77 AND (s.ends_on IS NULL OR s.generated_through<s.ends_on)))
      ORDER BY s.id LIMIT 50 FOR UPDATE LOOP
    prior:=hon.class_series_json(x);
    filled:=hon.class_series_fill_dates(x,coalesce(x.generated_through+1,today),through);
    UPDATE hon.class_series SET generated_through=greatest(coalesce(generated_through,through),through),version=version+1,updated_at=clock_timestamp()
      WHERE id=x.id RETURNING * INTO x;
    next_state:=jsonb_build_object('series',hon.class_series_json(x),'sessions',filled);
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(org,school,actor,'HUMAN_UI','schedule.series.top_up','CLASS_SERIES',x.id,prior,next_state,'SUCCEEDED',request,correlation);
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(org,school,'schedule.series.topped_up',1,'CLASS_SERIES',x.id,x.version,correlation,request,next_state);
    series_count:=series_count+1; created:=created+(filled->>'created')::integer;
    IF jsonb_array_length(skipped)+jsonb_array_length(filled->'skippedDates')<=100 THEN skipped:=skipped||(filled->'skippedDates'); END IF;
  END LOOP;
  result:=jsonb_build_object('series',series_count,'created',created,'skippedDates',skipped);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- 0239's series read plus whether a top-up is due (the same condition the top-up uses).
CREATE OR REPLACE FUNCTION hon.read_school_class_series(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb; today date;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  today:=hon.membership_school_today();
  result:=jsonb_build_object('localToday',to_char(today,'YYYY-MM-DD'),
    'timezone',(SELECT s.timezone FROM hon.schools s WHERE s.id=hon.current_school_id()),
    'fillLimit',to_char(today+84,'YYYY-MM-DD'),
    'topUpDue',EXISTS(SELECT 1 FROM hon.class_series s WHERE s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id()
      AND s.status='ACTIVE' AND s.ongoing AND (s.generated_through IS NULL OR (s.generated_through<today+77 AND (s.ends_on IS NULL OR s.generated_through<s.ends_on)))),
    'series',coalesce((SELECT jsonb_agg(hon.class_series_json(x) ORDER BY x.status,x.name,x.id) FROM (SELECT * FROM hon.class_series y
      WHERE y.organization_id=hon.current_organization_id() AND y.school_id=hon.current_school_id() ORDER BY y.status,y.name,y.id LIMIT 200) x),'[]'::jsonb),
    'programs',coalesce((SELECT jsonb_agg(jsonb_build_object('programId',g.id,'name',g.name) ORDER BY g.name,g.id) FROM (SELECT * FROM hon.programs z
      WHERE z.organization_id=hon.current_organization_id() AND z.school_id=hon.current_school_id() AND z.status<>'CANCELLED' ORDER BY z.name,z.id LIMIT 200) g),'[]'::jsonb));
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON COLUMN hon.class_series.ongoing IS '0251 when true, staff opening the class series page top the series up to 84 days ahead about once a week. Off by default.';
COMMENT ON FUNCTION hon.set_class_series_ongoing(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI switch for an ongoing class series (B-SCH-2 O1); turning it on fills through 84 days ahead. No automation, AI, communication or payment effect.';
COMMENT ON FUNCTION hon.top_up_class_series(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI top-up of the current school''s due ongoing class series to 84 days ahead (B-SCH-2 O2), sent by the staff page. Not a timer. No communication or payment effect.';

DO $$ DECLARE r text; f text; fns text[]:=ARRAY['hon.class_series_json(hon.class_series)','hon.class_series_fill_dates(hon.class_series,date,date)',
    'hon.set_class_series_ongoing(text,uuid,jsonb,text,uuid,uuid)','hon.top_up_class_series(text,jsonb,text,uuid,uuid)','hon.read_school_class_series(text)']; BEGIN
  EXECUTE 'REVOKE ALL (ongoing) ON hon.class_series FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (ongoing) ON hon.class_series FROM %I',r); END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_class_series_ongoing(text,uuid,jsonb,text,uuid,uuid),hon.top_up_class_series(text,jsonb,text,uuid,uuid),
      hon.read_school_class_series(text) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.class_series','SELECT') OR has_any_column_privilege('hon_runtime','hon.class_series','SELECT')
      OR has_any_column_privilege('hon_runtime','hon.class_series','UPDATE') OR has_any_column_privilege('hon_runtime','hon.class_sessions','UPDATE')
      OR has_function_privilege('hon_runtime','hon.class_series_fill_dates(hon.class_series,date,date)','EXECUTE')) THEN
    RAISE EXCEPTION 'Ongoing class series must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
