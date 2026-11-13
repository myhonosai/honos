BEGIN;

-- School booking types (0286, assigned by the coordinator 2026-11-12). The owner asked for Settings where a school makes its own
-- kinds of booking (a test reservation, a 2nd trial, a parent meeting) with weekly hours. The owner decided ("Owner picks per
-- type") that each type is an open link or for current families only, and ("Branded pages") that the page uses the 0285 branding.
-- Rules (docs/architecture/SCHOOL_BOOKING_TYPES.md):
--   T1  A type: name, description, template label, length 10-240 minutes, 1-50 spots per time, 1-14 weekly windows in school
--       time with no overlaps, 1-90 days ahead, 0-168 hours notice, audience OPEN or FAMILIES_ONLY, up to 5 questions, an
--       optional waiver and a thank-you message. At most 20 types per school that are not archived.
--   T2  DRAFT -> ACTIVE <-> PAUSED -> ARCHIVED (final). Edits never cancel a booking; spots never go below a future time's bookings.
--   T3  Times are worked out when asked (never stored); a local time that does not exist on a daylight-saving day is skipped.
--   T4  OPEN types: a family books with a name and an email or a mobile number, answers the required questions and ticks the
--       waiver; one future booking per email and per mobile per type; the time must have a spot. A retry with the same key
--       and request returns the same code.
--   T5  FAMILIES_ONLY types refuse public booking (family sign-in booking comes later).
--   T6  The booking code cancels the booking before it starts.
--   T7  Staff see bookings with contact, answers and waiver time; they can cancel or mark arrived (or undo arrived).
--   T8  Public reads show open spots only. Rate limits live here. No message, charge, CRM lead, student record or AI.
-- The runtime gains no table privilege: staff writes are direct-human SECURITY DEFINER commands, and public writes run as a
-- code-owned SYSTEM_SERVICE principal with no roles (the 0075 and 0261 shape).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School booking types require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School booking types require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.require_class_series_actor(text)') IS NULL OR to_regprocedure('hon.class_series_command_begin(text,text,text)') IS NULL
    OR to_regprocedure('hon.membership_school_today()') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL OR to_regprocedure('hon.school_event_text_ok(text,integer,integer)') IS NULL
    OR to_regprocedure('hon.read_public_school_branding(uuid)') IS NULL THEN
    RAISE EXCEPTION 'School booking types require 0224, 0239, 0261 and 0285';
  END IF;
END $$;

-- Code-owned public booking intake. No user, role, HQ, family or delegated authority belongs to it.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000286','SYSTEM_SERVICE','Code-owned public booking type intake');

-- Text that may span lines: the 0261 one-line rules with line breaks allowed inside.
CREATE FUNCTION hon.school_booking_text_ok(value text,max_length integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT value IS NOT NULL AND length(value)<=max_length AND hon.school_event_text_ok(translate(value,E'\n',' '),0,max_length)
$$;

-- T1/T2: one booking type. Immutable identity; every change raises the version by exactly one; ARCHIVED is final.
CREATE TABLE hon.school_booking_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24),'hex') CHECK (public_id ~ '^[a-f0-9]{48}$'),
  hash_secret text NOT NULL DEFAULT encode(gen_random_bytes(32),'hex') CHECK (hash_secret ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK (hon.school_event_text_ok(name,1,80)),
  description text NOT NULL DEFAULT '' CHECK (hon.school_booking_text_ok(description,500)),
  template text NOT NULL CHECK (template IN ('TEST_RESERVATION','SECOND_TRIAL','PARENT_MEETING','OTHER')),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 10 AND 240),
  spots_per_time integer NOT NULL CHECK (spots_per_time BETWEEN 1 AND 50),
  weekly_hours jsonb NOT NULL CHECK (jsonb_typeof(weekly_hours)='array' AND jsonb_array_length(weekly_hours) BETWEEN 1 AND 14),
  horizon_days integer NOT NULL CHECK (horizon_days BETWEEN 1 AND 90),
  notice_hours integer NOT NULL CHECK (notice_hours BETWEEN 0 AND 168),
  audience text NOT NULL CHECK (audience IN ('OPEN','FAMILIES_ONLY')),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions)='array' AND jsonb_array_length(questions)<=5),
  waiver text NOT NULL DEFAULT '' CHECK (hon.school_booking_text_ok(waiver,4000)),
  thank_you text NOT NULL DEFAULT '' CHECK (hon.school_booking_text_ok(thank_you,500)),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id)
);
CREATE INDEX school_booking_types_school_idx ON hon.school_booking_types(organization_id,school_id,status,id);

-- T4-T7: one family's booking. Contact details and answers live only here. The questions and waiver hash are kept as booked.
CREATE TABLE hon.school_booking_type_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  starts_at timestamptz NOT NULL CHECK (date_trunc('minute',starts_at)=starts_at),
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  local_date date NOT NULL,
  local_start time NOT NULL,
  family_name text NOT NULL CHECK (hon.school_event_text_ok(family_name,1,120)),
  email text CHECK (email IS NULL OR (length(email) <= 254 AND email=lower(email)
    AND email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$')),
  mobile text CHECK (mobile IS NULL OR mobile ~ '^\+[1-9][0-9]{6,14}$'),
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions)='array' AND jsonb_array_length(questions)<=5),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers)='array' AND jsonb_array_length(answers)=jsonb_array_length(questions)),
  waiver_hash text CHECK (waiver_hash IS NULL OR waiver_hash ~ '^[a-f0-9]{64}$'),
  waiver_accepted_at timestamptz,
  status text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','ARRIVED','CANCELLED')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  cancelled_by text CHECK (cancelled_by IS NULL OR cancelled_by IN ('FAMILY','STAFF')),
  cancelled_at timestamptz,
  arrived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (email IS NOT NULL OR mobile IS NOT NULL),
  CHECK ((waiver_hash IS NULL)=(waiver_accepted_at IS NULL)),
  CHECK ((status='CANCELLED')=(cancelled_by IS NOT NULL) AND (status='CANCELLED')=(cancelled_at IS NOT NULL)),
  CHECK ((status='ARRIVED')=(arrived_at IS NOT NULL)),
  UNIQUE (type_id,key_hash),
  UNIQUE (type_id,code_hash),
  FOREIGN KEY (type_id,organization_id,school_id) REFERENCES hon.school_booking_types(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX school_booking_type_bookings_time_idx ON hon.school_booking_type_bookings(type_id,starts_at,status);
CREATE INDEX school_booking_type_bookings_email_idx ON hon.school_booking_type_bookings(type_id,email) WHERE email IS NOT NULL;
CREATE INDEX school_booking_type_bookings_mobile_idx ON hon.school_booking_type_bookings(type_id,mobile) WHERE mobile IS NOT NULL;

-- T8: hourly public attempt counters per type and bucket (fixed words or keyed hashes, never raw contact).
CREATE TABLE hon.school_booking_type_rates (
  type_id uuid NOT NULL REFERENCES hon.school_booking_types(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket IN ('BOOK_ATTEMPTS','CANCEL_ATTEMPTS') OR bucket ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1001),
  PRIMARY KEY (type_id,bucket)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_booking_types','school_booking_type_bookings','school_booking_type_rates'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;
CREATE TRIGGER school_booking_types_no_truncate BEFORE TRUNCATE ON hon.school_booking_types FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_booking_type_bookings_no_truncate BEFORE TRUNCATE ON hon.school_booking_type_bookings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

CREATE FUNCTION hon.guard_school_booking_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'DRAFT' THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.public_id,NEW.hash_secret,NEW.actor_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.public_id,OLD.hash_secret,OLD.actor_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 OR OLD.status='ARCHIVED' OR (OLD.status<>'DRAFT' AND NEW.status='DRAFT') THEN
    RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_booking_types_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_booking_types FOR EACH ROW EXECUTE FUNCTION hon.guard_school_booking_type();

CREATE FUNCTION hon.guard_school_booking_type_booking() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'BOOKED' THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.type_id,NEW.organization_id,NEW.school_id,NEW.starts_at,NEW.ends_at,NEW.local_date,NEW.local_start,NEW.family_name,NEW.email,NEW.mobile,
      NEW.questions,NEW.answers,NEW.waiver_hash,NEW.waiver_accepted_at,NEW.key_hash,NEW.payload_hash,NEW.code_hash,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.type_id,OLD.organization_id,OLD.school_id,OLD.starts_at,OLD.ends_at,OLD.local_date,OLD.local_start,OLD.family_name,OLD.email,OLD.mobile,
      OLD.questions,OLD.answers,OLD.waiver_hash,OLD.waiver_accepted_at,OLD.key_hash,OLD.payload_hash,OLD.code_hash,OLD.created_at)
    OR NEW.version<>OLD.version+1
    OR NOT ((OLD.status,NEW.status) IN (('BOOKED','ARRIVED'),('BOOKED','CANCELLED'),('ARRIVED','BOOKED'))) THEN
    RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_booking_type_bookings_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_booking_type_bookings FOR EACH ROW EXECUTE FUNCTION hon.guard_school_booking_type_booking();

CREATE FUNCTION hon.school_booking_type_utc(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Live bookings at one time of one type.
CREATE FUNCTION hon.school_booking_type_taken(selected uuid,at_time timestamptz) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT count(*)::integer FROM hon.school_booking_type_bookings b WHERE b.type_id=selected AND b.starts_at=at_time AND b.status<>'CANCELLED'
$$;

-- T3: the bookable times of a type from now plus the notice to the end of the horizon, in order, at most max_count.
CREATE FUNCTION hon.school_booking_type_times(x hon.school_booking_types,tz text,max_count integer)
RETURNS TABLE(starts_at timestamptz,local_date date,local_start time)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE today date:=(clock_timestamp() AT TIME ZONE tz)::date; d date; w jsonb; a integer; z integer; m integer; t time; s timestamptz; n integer:=0;
  earliest timestamptz:=clock_timestamp()+make_interval(hours=>x.notice_hours);
BEGIN
  d:=today;
  WHILE d<=today+x.horizon_days AND n<max_count LOOP
    FOR w IN SELECT e FROM jsonb_array_elements(x.weekly_hours) e WHERE (e->>'day')::integer=extract(isodow FROM d)::integer LOOP
      a:=extract(epoch FROM (w->>'start')::time)::integer/60; z:=extract(epoch FROM (w->>'end')::time)::integer/60; m:=a;
      WHILE m+x.duration_minutes<=z AND n<max_count LOOP
        t:=TIME '00:00'+make_interval(mins=>m);
        s:=(d+t) AT TIME ZONE tz;
        IF (s AT TIME ZONE tz)::time=t AND (s AT TIME ZONE tz)::date=d AND s>=earliest THEN
          starts_at:=s; local_date:=d; local_start:=t; n:=n+1; RETURN NEXT;
        END IF;
        m:=m+x.duration_minutes;
      END LOOP;
    END LOOP;
    d:=d+1;
  END LOOP;
END $$;

-- T3/T4: whether one instant is a bookable time of the type right now.
CREATE FUNCTION hon.school_booking_type_time_ok(x hon.school_booking_types,tz text,s timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE ld date:=(s AT TIME ZONE tz)::date; lt time:=(s AT TIME ZONE tz)::time; mins integer;
BEGIN
  IF s IS NULL OR date_trunc('minute',s)<>s OR s<clock_timestamp()+make_interval(hours=>x.notice_hours)
    OR ld>(clock_timestamp() AT TIME ZONE tz)::date+x.horizon_days OR (ld+lt) AT TIME ZONE tz<>s THEN RETURN false; END IF;
  mins:=extract(epoch FROM lt)::integer/60;
  RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(x.weekly_hours) e WHERE (e->>'day')::integer=extract(isodow FROM ld)::integer
    AND mins>=extract(epoch FROM (e->>'start')::time)::integer/60
    AND mins+x.duration_minutes<=extract(epoch FROM (e->>'end')::time)::integer/60
    AND (mins-extract(epoch FROM (e->>'start')::time)::integer/60)%x.duration_minutes=0);
END $$;

CREATE FUNCTION hon.school_booking_type_json(x hon.school_booking_types) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('typeId',x.id,'publicId',x.public_id,'name',x.name,'description',x.description,'template',x.template,
    'durationMinutes',x.duration_minutes,'spotsPerTime',x.spots_per_time,'weeklyHours',x.weekly_hours,'horizonDays',x.horizon_days,
    'noticeHours',x.notice_hours,'audience',x.audience,'questions',x.questions,'waiver',x.waiver,'thankYou',x.thank_you,
    'status',x.status,'version',x.version,
    'upcomingCount',(SELECT count(*) FROM hon.school_booking_type_bookings b WHERE b.type_id=x.id AND b.status<>'CANCELLED' AND b.starts_at>=clock_timestamp())::integer,
    'createdAt',hon.school_booking_type_utc(x.created_at))
$$;

CREATE FUNCTION hon.school_booking_type_booking_json(b hon.school_booking_type_bookings) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('bookingId',b.id,'startsAt',hon.school_booking_type_utc(b.starts_at),'endsAt',hon.school_booking_type_utc(b.ends_at),
    'localDate',to_char(b.local_date,'YYYY-MM-DD'),'localStart',to_char(b.local_start,'HH24:MI'),'name',b.family_name,'email',b.email,'mobile',b.mobile,
    'questions',b.questions,'answers',b.answers,'waiverAcceptedAt',CASE WHEN b.waiver_accepted_at IS NULL THEN NULL ELSE hon.school_booking_type_utc(b.waiver_accepted_at) END,
    'status',b.status,'cancelledBy',b.cancelled_by,'version',b.version,'createdAt',hon.school_booking_type_utc(b.created_at))
$$;

-- Staff input for create/edit. Returns the normalized type (weekly hours sorted by day and start).
CREATE FUNCTION hon.school_booking_type_input(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE k text; w jsonb; q jsonb; dur integer; hours jsonb; qs jsonb:='[]'::jsonb;
  keys text[]:=ARRAY['expectedVersion','name','description','template','durationMinutes','spotsPerTime','weeklyHours','horizonDays',
    'noticeHours','audience','questions','waiver','thankYou'];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16384 OR NOT p ?& keys
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x<>ALL(keys))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p->'durationMinutes') IS DISTINCT FROM 'number' OR (p->>'durationMinutes') !~ '^[1-9][0-9]{1,2}$' OR (p->>'durationMinutes')::integer NOT BETWEEN 10 AND 240
    OR jsonb_typeof(p->'spotsPerTime') IS DISTINCT FROM 'number' OR (p->>'spotsPerTime') !~ '^[1-9][0-9]?$' OR (p->>'spotsPerTime')::integer NOT BETWEEN 1 AND 50
    OR jsonb_typeof(p->'horizonDays') IS DISTINCT FROM 'number' OR (p->>'horizonDays') !~ '^[1-9][0-9]?$' OR (p->>'horizonDays')::integer NOT BETWEEN 1 AND 90
    OR jsonb_typeof(p->'noticeHours') IS DISTINCT FROM 'number' OR (p->>'noticeHours') !~ '^(0|[1-9][0-9]{0,2})$' OR (p->>'noticeHours')::integer NOT BETWEEN 0 AND 168
    OR jsonb_typeof(p->'template') IS DISTINCT FROM 'string' OR (p->>'template') NOT IN ('TEST_RESERVATION','SECOND_TRIAL','PARENT_MEETING','OTHER')
    OR jsonb_typeof(p->'audience') IS DISTINCT FROM 'string' OR (p->>'audience') NOT IN ('OPEN','FAMILIES_ONLY')
    OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(p->>'name',1,80)
    OR jsonb_typeof(p->'weeklyHours') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'weeklyHours') NOT BETWEEN 1 AND 14
    OR jsonb_typeof(p->'questions') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'questions')>5 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOREACH k IN ARRAY ARRAY['description','waiver','thankYou'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR NOT hon.school_booking_text_ok(p->>k,CASE k WHEN 'waiver' THEN 4000 ELSE 500 END) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  dur:=(p->>'durationMinutes')::integer;
  FOR w IN SELECT e FROM jsonb_array_elements(p->'weeklyHours') e LOOP
    IF jsonb_typeof(w) IS DISTINCT FROM 'object' OR NOT w ?& ARRAY['day','start','end'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(w) x WHERE x NOT IN ('day','start','end'))
      OR jsonb_typeof(w->'day') IS DISTINCT FROM 'number' OR (w->>'day') !~ '^[1-7]$'
      OR jsonb_typeof(w->'start') IS DISTINCT FROM 'string' OR (w->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR jsonb_typeof(w->'end') IS DISTINCT FROM 'string' OR (w->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR (w->>'end')::time-(w->>'start')::time<make_interval(mins=>dur) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'weeklyHours') WITH ORDINALITY a(e,i) JOIN jsonb_array_elements(p->'weeklyHours') WITH ORDINALITY b(e,j)
      ON a.i<b.j AND a.e->>'day'=b.e->>'day' AND (a.e->>'start')::time<(b.e->>'end')::time AND (b.e->>'start')::time<(a.e->>'end')::time) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(jsonb_build_object('day',(e->>'day')::integer,'start',e->>'start','end',e->>'end') ORDER BY (e->>'day')::integer,e->>'start')
    INTO hours FROM jsonb_array_elements(p->'weeklyHours') e;
  FOR q IN SELECT e FROM jsonb_array_elements(p->'questions') e LOOP
    IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR NOT q ?& ARRAY['label','kind','required'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(q) x WHERE x NOT IN ('label','kind','required'))
      OR jsonb_typeof(q->'label') IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(q->>'label',1,120)
      OR jsonb_typeof(q->'kind') IS DISTINCT FROM 'string' OR (q->>'kind') NOT IN ('TEXT','YES_NO')
      OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    qs:=qs||jsonb_build_array(jsonb_build_object('label',q->>'label','kind',q->>'kind','required',(q->>'required')::boolean));
  END LOOP;
  RETURN jsonb_build_object('expectedVersion',(p->>'expectedVersion')::integer,'name',p->>'name','description',p->>'description','template',p->>'template',
    'durationMinutes',dur,'spotsPerTime',(p->>'spotsPerTime')::integer,'weeklyHours',hours,'horizonDays',(p->>'horizonDays')::integer,
    'noticeHours',(p->>'noticeHours')::integer,'audience',p->>'audience','questions',qs,'waiver',p->>'waiver','thankYou',p->>'thankYou');
END $$;

CREATE FUNCTION hon.school_booking_type_command_finish(subject text,key text,actor uuid,result jsonb,action text,entity_type text,entity uuid,
  prior_state jsonb,next_state jsonb,event_type text,entity_version integer,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF entity_type NOT IN ('SCHOOL_BOOKING_TYPE','SCHOOL_BOOKING_TYPE_BOOKING') THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity_type,entity,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event_type,1,entity_type,entity,entity_version,correlation,request,next_state);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- T1/T2: create (selected NULL, expectedVersion 0) or edit a type that is not archived.
CREATE FUNCTION hon.save_school_booking_type(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; v jsonb;
  x hon.school_booking_types%ROWTYPE; prior jsonb; result jsonb; most integer;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v:=hon.school_booking_type_input(p);
  IF (selected IS NULL)<>((v->>'expectedVersion')::integer=0) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.booking_type.save','typeId',selected,'input',v)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  IF selected IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_booking_types:'||school::text,0));
    IF (SELECT count(*) FROM hon.school_booking_types t WHERE t.organization_id=org AND t.school_id=school AND t.status<>'ARCHIVED')>=20 THEN
      RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_LIMIT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_booking_types(organization_id,school_id,name,description,template,duration_minutes,spots_per_time,weekly_hours,horizon_days,
        notice_hours,audience,questions,waiver,thank_you,actor_principal_id)
      VALUES(org,school,v->>'name',v->>'description',v->>'template',(v->>'durationMinutes')::integer,(v->>'spotsPerTime')::integer,v->'weeklyHours',
        (v->>'horizonDays')::integer,(v->>'noticeHours')::integer,v->>'audience',v->'questions',v->>'waiver',v->>'thankYou',actor) RETURNING * INTO x;
    prior:=NULL;
  ELSE
    SELECT * INTO x FROM hon.school_booking_types t WHERE t.id=selected AND t.organization_id=org AND t.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF x.version<>(v->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF x.status='ARCHIVED' THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_ARCHIVED' USING ERRCODE='40001'; END IF;
    SELECT coalesce(max(n),0) INTO most FROM (SELECT count(*)::integer n FROM hon.school_booking_type_bookings b
      WHERE b.type_id=x.id AND b.status<>'CANCELLED' AND b.starts_at>=clock_timestamp() GROUP BY b.starts_at) c;
    IF (v->>'spotsPerTime')::integer<most THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_SPOTS_BELOW_BOOKED' USING ERRCODE='40001'; END IF;
    prior:=jsonb_build_object('typeId',x.id,'status',x.status,'version',x.version);
    UPDATE hon.school_booking_types SET name=v->>'name',description=v->>'description',template=v->>'template',duration_minutes=(v->>'durationMinutes')::integer,
      spots_per_time=(v->>'spotsPerTime')::integer,weekly_hours=v->'weeklyHours',horizon_days=(v->>'horizonDays')::integer,notice_hours=(v->>'noticeHours')::integer,
      audience=v->>'audience',questions=v->'questions',waiver=v->>'waiver',thank_you=v->>'thankYou',version=version+1,updated_at=clock_timestamp()
      WHERE id=x.id RETURNING * INTO x;
  END IF;
  result:=jsonb_build_object('bookingType',hon.school_booking_type_json(x));
  PERFORM hon.school_booking_type_command_finish(subject,key,actor,result,'schedule.booking_type.save','SCHOOL_BOOKING_TYPE',x.id,prior,
    jsonb_build_object('typeId',x.id,'status',x.status,'version',x.version),'schedule.booking_type.saved',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- T2: activate (needs at least one bookable time), pause, resume or archive.
CREATE FUNCTION hon.set_school_booking_type_status(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  x hon.school_booking_types%ROWTYPE; prior jsonb; result jsonb; target text; tz text;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','status']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','status'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN ('ACTIVE','PAUSED','ARCHIVED')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=p->>'status';
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.booking_type.status','typeId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO x FROM hon.school_booking_types t WHERE t.id=selected AND t.organization_id=org AND t.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status='ARCHIVED' THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_ARCHIVED' USING ERRCODE='40001'; END IF;
  IF NOT ((x.status,target) IN (('DRAFT','ACTIVE'),('ACTIVE','PAUSED'),('PAUSED','ACTIVE'),('DRAFT','ARCHIVED'),('ACTIVE','ARCHIVED'),('PAUSED','ARCHIVED'))) THEN
    RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_STATUS_INVALID' USING ERRCODE='40001'; END IF;
  IF target='ACTIVE' THEN
    SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
    IF NOT EXISTS(SELECT 1 FROM hon.school_booking_type_times(x,tz,1)) THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_NO_TIMES' USING ERRCODE='22023'; END IF;
  END IF;
  prior:=jsonb_build_object('typeId',x.id,'status',x.status,'version',x.version);
  UPDATE hon.school_booking_types SET status=target,version=version+1,updated_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x;
  result:=jsonb_build_object('bookingType',hon.school_booking_type_json(x));
  PERFORM hon.school_booking_type_command_finish(subject,key,actor,result,'schedule.booking_type.status','SCHOOL_BOOKING_TYPE',x.id,prior,
    jsonb_build_object('typeId',x.id,'status',x.status,'version',x.version),'schedule.booking_type.status_set',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- T7: staff mark a booking arrived, undo arrived (BOOKED), or cancel it.
CREATE FUNCTION hon.set_school_booking_type_booking_status(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  b hon.school_booking_type_bookings%ROWTYPE; prior jsonb; result jsonb; target text;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','status']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','status'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN ('BOOKED','ARRIVED','CANCELLED')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=p->>'status';
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.booking_type.booking.status','bookingId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO b FROM hon.school_booking_type_bookings x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_BOOKING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Lock order shared with the public paths: type -> booking.
  PERFORM 1 FROM hon.school_booking_types t WHERE t.id=b.type_id FOR SHARE;
  SELECT * INTO b FROM hon.school_booking_type_bookings x WHERE x.id=selected FOR UPDATE;
  IF b.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NOT ((b.status,target) IN (('BOOKED','ARRIVED'),('BOOKED','CANCELLED'),('ARRIVED','BOOKED'))) THEN
    RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_BOOKING_STATUS_INVALID' USING ERRCODE='40001'; END IF;
  prior:=jsonb_build_object('bookingId',b.id,'status',b.status,'version',b.version);
  UPDATE hon.school_booking_type_bookings SET status=target,version=version+1,updated_at=clock_timestamp(),
    arrived_at=CASE WHEN target='ARRIVED' THEN clock_timestamp() ELSE NULL END,
    cancelled_by=CASE WHEN target='CANCELLED' THEN 'STAFF' ELSE NULL END,
    cancelled_at=CASE WHEN target='CANCELLED' THEN clock_timestamp() ELSE NULL END
    WHERE id=b.id RETURNING * INTO b;
  result:=jsonb_build_object('booking',hon.school_booking_type_booking_json(b));
  PERFORM hon.school_booking_type_command_finish(subject,key,actor,result,'schedule.booking_type.booking.status','SCHOOL_BOOKING_TYPE_BOOKING',b.id,prior,
    jsonb_build_object('bookingId',b.id,'typeId',b.type_id,'status',b.status,'version',b.version),'schedule.booking_type.booking_status_set',b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Staff reads (schedule.session.manage: bookings carry family contact details and answers).
CREATE FUNCTION hon.read_school_booking_types(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  result:=jsonb_build_object('localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'timezone',(SELECT s.timezone FROM hon.schools s WHERE s.id=hon.current_school_id()),
    'bookingTypes',coalesce((SELECT jsonb_agg(hon.school_booking_type_json(x) ORDER BY x.status='ARCHIVED',x.created_at,x.id) FROM (SELECT * FROM hon.school_booking_types y
      WHERE y.organization_id=hon.current_organization_id() AND y.school_id=hon.current_school_id() ORDER BY y.status='ARCHIVED',y.created_at,y.id LIMIT 100) x),'[]'::jsonb));
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- One type with its bookings from the start of the school's today, soonest first, at most 500.
CREATE FUNCTION hon.read_school_booking_type(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; x hon.school_booking_types%ROWTYPE; result jsonb; tz text;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  SELECT * INTO x FROM hon.school_booking_types t WHERE t.id=selected AND t.organization_id=hon.current_organization_id() AND t.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=x.school_id;
  result:=jsonb_build_object('bookingType',hon.school_booking_type_json(x),'timezone',tz,
    'bookings',coalesce((SELECT jsonb_agg(hon.school_booking_type_booking_json(b) ORDER BY b.starts_at,b.created_at,b.id) FROM (SELECT * FROM hon.school_booking_type_bookings y
      WHERE y.type_id=x.id AND y.local_date>=hon.membership_school_today() ORDER BY y.starts_at,y.created_at,y.id LIMIT 500) b),'[]'::jsonb));
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BOOKING_TYPE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- T8: one hourly counter per type and bucket.
CREATE FUNCTION hon.take_school_booking_type_rate(selected uuid,bucket_name text,limit_count integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; asof timestamptz:=clock_timestamp();
BEGIN
  INSERT INTO hon.school_booking_type_rates(type_id,bucket,window_start,attempts) VALUES(selected,bucket_name,asof,1)
  ON CONFLICT(type_id,bucket) DO UPDATE SET
    window_start=CASE WHEN hon.school_booking_type_rates.window_start<=asof-interval '1 hour' THEN asof ELSE hon.school_booking_type_rates.window_start END,
    attempts=CASE WHEN hon.school_booking_type_rates.window_start<=asof-interval '1 hour' THEN 1 ELSE least(hon.school_booking_type_rates.attempts+1,1001) END
  RETURNING attempts INTO n;
  RETURN n<=limit_count;
END $$;

-- The type the public may see: ACTIVE, PAUSED or ARCHIVED (never DRAFT), with a live school, organization and entitlement.
CREATE FUNCTION hon.public_school_booking_type(pid text) RETURNS hon.school_booking_types
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT t.* FROM hon.school_booking_types t JOIN hon.organizations o ON o.id=t.organization_id JOIN hon.schools s ON s.id=t.school_id AND s.organization_id=t.organization_id
  WHERE pid ~ '^[a-f0-9]{48}$' AND t.public_id=pid AND t.status IN ('ACTIVE','PAUSED','ARCHIVED') AND o.status='ACTIVE' AND s.status='ACTIVE'
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements x WHERE x.organization_id=t.organization_id AND x.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND x.status='ACTIVE' AND x.effective_from<=clock_timestamp() AND (x.effective_until IS NULL OR x.effective_until>clock_timestamp()))
$$;

-- Public read: a whitelisted projection with the school's branding and open times only (none for FAMILIES_ONLY or not ACTIVE).
CREATE FUNCTION hon.read_public_school_booking_type(pid text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_booking_types%ROWTYPE; tz text; branding jsonb;
BEGIN
  x:=hon.public_school_booking_type(pid);
  IF x.id IS NULL THEN RETURN NULL; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=x.school_id AND s.organization_id=x.organization_id;
  branding:=hon.read_public_school_branding(x.school_id);
  IF branding IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('publicId',x.public_id,'schoolName',branding->>'schoolName',
    'branding',jsonb_build_object('logoUrl',branding->'logoUrl','coverUrl',branding->'coverUrl','accentColor',branding->'accentColor','contactLine',branding->'contactLine'),
    'name',x.name,'description',x.description,'template',x.template,'durationMinutes',x.duration_minutes,'audience',x.audience,
    'questions',x.questions,'waiver',x.waiver,'timezone',tz,
    'status',CASE x.status WHEN 'ACTIVE' THEN 'OPEN' WHEN 'PAUSED' THEN 'PAUSED' ELSE 'CLOSED' END,
    'times',CASE WHEN x.status='ACTIVE' AND x.audience='OPEN' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('startsAt',hon.school_booking_type_utc(t.starts_at),
      'localDate',to_char(t.local_date,'YYYY-MM-DD'),'localStart',to_char(t.local_start,'HH24:MI'),
      'localEnd',to_char(t.local_start+make_interval(mins=>x.duration_minutes),'HH24:MI'),
      'spotsLeft',greatest(x.spots_per_time-hon.school_booking_type_taken(x.id,t.starts_at),0)) ORDER BY t.starts_at)
      FROM hon.school_booking_type_times(x,tz,400) t),'[]'::jsonb) ELSE '[]'::jsonb END);
END $$;

-- Public booking input: {startsAt,name,email,mobile,answers,waiverAccepted,website}; website is a honeypot that must be empty.
-- Answers line up with the type's questions: a string (up to 300) for TEXT, true/false/null for YES_NO; required ones must be given.
CREATE FUNCTION hon.school_booking_type_booking_input(x hon.school_booking_types,p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE nm text; email text; mobile text; i integer; q jsonb; a jsonb; answers jsonb:='[]'::jsonb;
  keys text[]:=ARRAY['startsAt','name','email','mobile','answers','waiverAccepted','website'];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>6144 OR NOT p ?& keys
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(keys))
    OR jsonb_typeof(p->'startsAt') IS DISTINCT FROM 'string' OR (p->>'startsAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\.000Z$'
    OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'email') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'mobile') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'website') IS DISTINCT FROM 'string' OR p->>'website'<>''
    OR jsonb_typeof(p->'waiverAccepted') IS DISTINCT FROM 'boolean' OR ((p->>'waiverAccepted')::boolean<>(x.waiver<>''))
    OR jsonb_typeof(p->'answers') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'answers')<>jsonb_array_length(x.questions) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  nm:=p->>'name'; email:=lower(p->>'email'); mobile:=p->>'mobile';
  IF NOT hon.school_event_text_ok(nm,1,120) OR length(email)>254 OR length(mobile)>16
    OR (email<>'' AND email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$')
    OR (mobile<>'' AND mobile !~ '^\+[1-9][0-9]{6,14}$') OR (email='' AND mobile='') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR i IN 0..jsonb_array_length(x.questions)-1 LOOP
    q:=x.questions->i; a:=p->'answers'->i;
    IF q->>'kind'='TEXT' THEN
      IF jsonb_typeof(a) IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(a#>>'{}',CASE WHEN (q->>'required')::boolean THEN 1 ELSE 0 END,300) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    ELSIF NOT (jsonb_typeof(a)='boolean' OR (jsonb_typeof(a)='null' AND NOT (q->>'required')::boolean)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
    END IF;
    answers:=answers||jsonb_build_array(a);
  END LOOP;
  RETURN jsonb_build_object('startsAt',p->>'startsAt','name',nm,'email',email,'mobile',mobile,'answers',answers,'waiverAccepted',(p->>'waiverAccepted')::boolean);
END $$;

-- T4: book. Returns {result}: BOOKED (with code, time and thank-you), INVALID, CLOSED, FAMILIES_ONLY, FULL, TIME_NOT_OFFERED, ALREADY_BOOKED or RATE_LIMITED.
CREATE FUNCTION hon.book_public_school_booking_type(pid text,p jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_booking_types%ROWTYPE; v jsonb; kh text; ph text; code text; b hon.school_booking_type_bookings%ROWTYPE;
  contact text; tz text; s timestamptz; request uuid:=gen_random_uuid();
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  x:=hon.public_school_booking_type(pid);
  IF x.id IS NULL THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  -- Lock order: organization -> school -> type -> booking (the staff paths take type -> booking). The type lock serializes bookings,
  -- so the spot count and the one-booking-per-contact rule hold under concurrent families.
  PERFORM 1 FROM hon.organizations WHERE id=x.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  SELECT timezone INTO tz FROM hon.schools WHERE id=x.school_id AND organization_id=x.organization_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  SELECT * INTO x FROM hon.school_booking_types WHERE id=x.id FOR UPDATE;
  PERFORM 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000286' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000286')
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000286')
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000286') THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  DELETE FROM hon.school_booking_type_rates WHERE type_id=x.id AND window_start<=clock_timestamp()-interval '1 hour';
  IF NOT hon.take_school_booking_type_rate(x.id,'BOOK_ATTEMPTS',600) THEN RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  BEGIN v:=hon.school_booking_type_booking_input(x,p); EXCEPTION WHEN SQLSTATE '22023' THEN RETURN jsonb_build_object('result','INVALID'); END;
  kh:=encode(sha256(convert_to(x.hash_secret||':key:'||key,'UTF8')),'hex');
  ph:=encode(sha256(convert_to(x.hash_secret||':payload:'||v::text,'UTF8')),'hex');
  code:=upper(substr(encode(sha256(convert_to(x.hash_secret||':code:'||kh,'UTF8')),'hex'),1,12));
  -- An exact retry returns the same booking and code, whatever has happened since.
  SELECT * INTO b FROM hon.school_booking_type_bookings WHERE type_id=x.id AND key_hash=kh;
  IF FOUND THEN
    IF b.payload_hash<>ph THEN RETURN jsonb_build_object('result','INVALID'); END IF;
    RETURN jsonb_build_object('result','BOOKED','code',code,'startsAt',hon.school_booking_type_utc(b.starts_at),'localDate',to_char(b.local_date,'YYYY-MM-DD'),
      'localStart',to_char(b.local_start,'HH24:MI'),'thankYou',x.thank_you,'status',b.status);
  END IF;
  FOREACH contact IN ARRAY ARRAY[nullif(v->>'email',''),nullif(v->>'mobile','')] LOOP
    IF contact IS NOT NULL AND NOT hon.take_school_booking_type_rate(x.id,encode(sha256(convert_to(x.hash_secret||':contact:'||contact,'UTF8')),'hex'),5) THEN
      RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  END LOOP;
  IF x.status<>'ACTIVE' THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  IF x.audience<>'OPEN' THEN RETURN jsonb_build_object('result','FAMILIES_ONLY'); END IF;
  s:=(v->>'startsAt')::timestamptz;
  IF NOT hon.school_booking_type_time_ok(x,tz,s) THEN RETURN jsonb_build_object('result','TIME_NOT_OFFERED'); END IF;
  IF EXISTS(SELECT 1 FROM hon.school_booking_type_bookings y WHERE y.type_id=x.id AND y.status<>'CANCELLED' AND y.starts_at>=clock_timestamp()
      AND ((v->>'email'<>'' AND y.email=v->>'email') OR (v->>'mobile'<>'' AND y.mobile=v->>'mobile'))) THEN
    RETURN jsonb_build_object('result','ALREADY_BOOKED'); END IF;
  IF hon.school_booking_type_taken(x.id,s)>=x.spots_per_time THEN RETURN jsonb_build_object('result','FULL'); END IF;
  INSERT INTO hon.school_booking_type_bookings(type_id,organization_id,school_id,starts_at,ends_at,local_date,local_start,family_name,email,mobile,
      questions,answers,waiver_hash,waiver_accepted_at,key_hash,payload_hash,code_hash)
    VALUES(x.id,x.organization_id,x.school_id,s,s+make_interval(mins=>x.duration_minutes),(s AT TIME ZONE tz)::date,(s AT TIME ZONE tz)::time,
      v->>'name',nullif(v->>'email',''),nullif(v->>'mobile',''),x.questions,v->'answers',
      CASE WHEN x.waiver<>'' THEN encode(sha256(convert_to(x.waiver,'UTF8')),'hex') END,CASE WHEN x.waiver<>'' THEN clock_timestamp() END,
      kh,ph,encode(sha256(convert_to(x.hash_secret||':code-check:'||code,'UTF8')),'hex')) RETURNING * INTO b;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(x.organization_id,x.school_id,'00000000-0000-4000-8000-000000000286','PUBLIC_API','schedule.booking_type.booking.create','SCHOOL_BOOKING_TYPE_BOOKING',b.id,
      jsonb_build_object('bookingId',b.id,'typeId',x.id,'status',b.status,'version',1),'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(x.organization_id,x.school_id,'schedule.booking_type.booking_created',1,'SCHOOL_BOOKING_TYPE_BOOKING',b.id,1,request,request,
      jsonb_build_object('bookingId',b.id,'typeId',x.id,'internalOnly',true));
  RETURN jsonb_build_object('result','BOOKED','code',code,'startsAt',hon.school_booking_type_utc(b.starts_at),'localDate',to_char(b.local_date,'YYYY-MM-DD'),
    'localStart',to_char(b.local_start,'HH24:MI'),'thankYou',x.thank_you,'status',b.status);
END $$;

-- T6: cancel with the booking code. Returns {result} CANCELLED, INVALID, STARTED or RATE_LIMITED.
CREATE FUNCTION hon.cancel_public_school_booking_type_booking(pid text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_booking_types%ROWTYPE; code text; b hon.school_booking_type_bookings%ROWTYPE; request uuid:=gen_random_uuid();
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'code'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'code') OR jsonb_typeof(p->'code') IS DISTINCT FROM 'string' THEN
    RETURN jsonb_build_object('result','INVALID'); END IF;
  code:=upper(replace(p->>'code','-',''));
  IF code !~ '^[A-F0-9]{12}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  x:=hon.public_school_booking_type(pid);
  IF x.id IS NULL THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  PERFORM 1 FROM hon.organizations WHERE id=x.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  PERFORM 1 FROM hon.schools WHERE id=x.school_id AND organization_id=x.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  SELECT * INTO x FROM hon.school_booking_types WHERE id=x.id FOR SHARE;
  DELETE FROM hon.school_booking_type_rates WHERE type_id=x.id AND window_start<=clock_timestamp()-interval '1 hour';
  IF NOT hon.take_school_booking_type_rate(x.id,'CANCEL_ATTEMPTS',300) THEN RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  SELECT * INTO b FROM hon.school_booking_type_bookings WHERE type_id=x.id AND code_hash=encode(sha256(convert_to(x.hash_secret||':code-check:'||code,'UTF8')),'hex') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  IF b.status='CANCELLED' THEN RETURN jsonb_build_object('result','CANCELLED'); END IF;
  IF b.status<>'BOOKED' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  IF b.starts_at<=clock_timestamp() THEN RETURN jsonb_build_object('result','STARTED'); END IF;
  UPDATE hon.school_booking_type_bookings SET status='CANCELLED',cancelled_by='FAMILY',cancelled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=b.id RETURNING * INTO b;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(x.organization_id,x.school_id,'00000000-0000-4000-8000-000000000286','PUBLIC_API','schedule.booking_type.booking.cancel','SCHOOL_BOOKING_TYPE_BOOKING',b.id,
      jsonb_build_object('bookingId',b.id,'typeId',x.id,'status',b.status,'version',b.version),'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(x.organization_id,x.school_id,'schedule.booking_type.booking_cancelled',1,'SCHOOL_BOOKING_TYPE_BOOKING',b.id,b.version,request,request,
      jsonb_build_object('bookingId',b.id,'typeId',x.id,'internalOnly',true));
  RETURN jsonb_build_object('result','CANCELLED');
END $$;

COMMENT ON TABLE hon.school_booking_types IS '0286 school booking types with weekly hours (T1-T3). Private.';
COMMENT ON TABLE hon.school_booking_type_bookings IS '0286 family bookings of a booking type with contact details and answers (T4-T7). Never deleted. Private.';
COMMENT ON TABLE hon.school_booking_type_rates IS '0286 hourly public attempt counters. Private.';
COMMENT ON FUNCTION hon.book_public_school_booking_type(text,jsonb,text) IS
'Public no-account booking of an ACTIVE OPEN school booking type (T4): one future booking per email and per mobile, spots per time enforced under the type lock, exact retry returns the same code. No message, charge, lead or AI.';

DO $$ DECLARE r text; t text; f text; fns text[]:=ARRAY['hon.school_booking_text_ok(text,integer)','hon.guard_school_booking_type()',
    'hon.guard_school_booking_type_booking()','hon.school_booking_type_utc(timestamp with time zone)','hon.school_booking_type_taken(uuid,timestamp with time zone)',
    'hon.school_booking_type_times(hon.school_booking_types,text,integer)','hon.school_booking_type_time_ok(hon.school_booking_types,text,timestamp with time zone)',
    'hon.school_booking_type_json(hon.school_booking_types)','hon.school_booking_type_booking_json(hon.school_booking_type_bookings)','hon.school_booking_type_input(jsonb)',
    'hon.school_booking_type_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
    'hon.save_school_booking_type(text,uuid,jsonb,text,uuid,uuid)','hon.set_school_booking_type_status(text,uuid,jsonb,text,uuid,uuid)',
    'hon.set_school_booking_type_booking_status(text,uuid,jsonb,text,uuid,uuid)','hon.read_school_booking_types(text)','hon.read_school_booking_type(text,uuid)',
    'hon.take_school_booking_type_rate(uuid,text,integer)','hon.public_school_booking_type(text)','hon.read_public_school_booking_type(text)',
    'hon.school_booking_type_booking_input(hon.school_booking_types,jsonb)','hon.book_public_school_booking_type(text,jsonb,text)',
    'hon.cancel_public_school_booking_type_booking(text,jsonb)']; BEGIN
  FOREACH t IN ARRAY ARRAY['school_booking_types','school_booking_type_bookings','school_booking_type_rates'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.save_school_booking_type(text,uuid,jsonb,text,uuid,uuid),hon.set_school_booking_type_status(text,uuid,jsonb,text,uuid,uuid),
      hon.set_school_booking_type_booking_status(text,uuid,jsonb,text,uuid,uuid),hon.read_school_booking_types(text),hon.read_school_booking_type(text,uuid),
      hon.read_public_school_booking_type(text),hon.book_public_school_booking_type(text,jsonb,text),hon.cancel_public_school_booking_type_booking(text,jsonb) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.school_booking_types','SELECT') OR has_table_privilege('hon_runtime','hon.school_booking_type_bookings','SELECT')
      OR has_table_privilege('hon_runtime','hon.school_booking_type_rates','SELECT')) THEN
    RAISE EXCEPTION 'School booking types must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
