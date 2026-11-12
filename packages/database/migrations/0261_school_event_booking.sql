BEGIN;

-- B-SCH-3 sale-day and event slot booking (0261, assigned by the coordinator 2026-11-11). Asked for by the owner: a school
-- runs a one-off day (holiday sale, open house, belt test, picture day) and families book a time slot without an account.
-- Rules (docs/architecture/SCHOOL_EVENT_SLOT_BOOKING.md):
--   E1  A one-day event in school time (title, optional description and place, a local date from today to 365 days ahead,
--       opening and closing times, slot length 10-240 minutes, 1-500 spots per slot). Staff with the existing
--       schedule.session.manage permission create and edit it as a DRAFT.
--   E2  Publishing makes the slots (each fits inside opening to closing, at most 96; a local time that does not exist on a
--       daylight-saving day is skipped and reported) and turns on the public link. After that the date and times are fixed;
--       text and spots per slot can change, but spots never go below the most-booked slot.
--   E3  Closing stops new bookings (families can still cancel; reopening is allowed). Cancelling the event is final.
--   E4  A family books with a name and an email or a mobile number; one live booking per email and per mobile per event;
--       the slot must have a spot and must not have started. The family gets a booking code. A retry with the same key and
--       the same request returns the same code.
--   E5  The booking code cancels the booking before its slot starts.
--   E6  Staff see slots and who is coming, and can cancel a booking or mark it arrived (or undo arrived).
--   E7  Public reads show open spots only, never names. Rate limits are kept here. No message, charge, CRM lead, student
--       record or AI. Audit and outbox carry ids only.
-- The runtime gains no table privilege: staff writes are direct-human SECURITY DEFINER commands, and public writes run as a
-- code-owned SYSTEM_SERVICE principal with no roles (the 0075 public form shape).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School event booking requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School event booking requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.require_class_series_actor(text)') IS NULL OR to_regprocedure('hon.class_series_command_begin(text,text,text)') IS NULL
    OR to_regprocedure('hon.membership_school_today()') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.membership_pause_date(jsonb)') IS NULL OR to_regprocedure('hon.membership_local_date(timestamp with time zone,text)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'School event booking requires 0224 and 0239';
  END IF;
END $$;

-- Code-owned public booking intake. No user, role, HQ, family or delegated authority belongs to it.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000261','SYSTEM_SERVICE','Code-owned public event booking intake');

-- One line of visible text: trimmed, no control or invisible formatting characters, no spreadsheet-formula start.
CREATE FUNCTION hon.school_event_text_ok(value text,min_length integer,max_length integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT value IS NOT NULL AND length(value) BETWEEN min_length AND max_length
    AND value=regexp_replace(value,'^[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+|[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+$','','g')
    AND value !~ '[[:cntrl:]\u0080-\u009F\u2028-\u2029\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]'
    AND value !~ '^[=+@-]'
$$;

-- E1/E2: one event. Immutable identity; every change raises the version by exactly one; CANCELLED is final.
CREATE TABLE hon.school_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24),'hex') CHECK (public_id ~ '^[a-f0-9]{48}$'),
  hash_secret text NOT NULL DEFAULT encode(gen_random_bytes(32),'hex') CHECK (hash_secret ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (hon.school_event_text_ok(title,1,120)),
  description text NOT NULL DEFAULT '' CHECK (hon.school_event_text_ok(description,0,500)),
  place text NOT NULL DEFAULT '' CHECK (hon.school_event_text_ok(place,0,120)),
  local_date date NOT NULL CHECK (local_date >= DATE '2000-01-01'),
  opens_at time NOT NULL CHECK (date_trunc('minute',opens_at)=opens_at),
  closes_at time NOT NULL CHECK (date_trunc('minute',closes_at)=closes_at),
  slot_minutes integer NOT NULL CHECK (slot_minutes BETWEEN 10 AND 240),
  spots_per_slot integer NOT NULL CHECK (spots_per_slot BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','CLOSED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (closes_at > opens_at AND closes_at - opens_at >= make_interval(mins=>slot_minutes)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id)
);
CREATE INDEX school_events_school_idx ON hon.school_events(organization_id,school_id,local_date,id);

-- E2: the slots publishing made. Never rewritten or deleted.
CREATE TABLE hon.school_event_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 95),
  local_start time NOT NULL,
  local_end time NOT NULL CHECK (local_end > local_start),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  UNIQUE (event_id,position),
  UNIQUE (id,event_id,organization_id,school_id),
  FOREIGN KEY (event_id,organization_id,school_id) REFERENCES hon.school_events(id,organization_id,school_id) ON DELETE RESTRICT
);

-- E4-E6: one family's booking. Contact details live only here.
CREATE TABLE hon.school_event_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_name text NOT NULL CHECK (hon.school_event_text_ok(family_name,1,120)),
  email text CHECK (email IS NULL OR (length(email) <= 254 AND email=lower(email)
    AND email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$')),
  mobile text CHECK (mobile IS NULL OR mobile ~ '^\+[1-9][0-9]{6,14}$'),
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
  CHECK ((status='CANCELLED')=(cancelled_by IS NOT NULL) AND (status='CANCELLED')=(cancelled_at IS NOT NULL)),
  CHECK ((status='ARRIVED')=(arrived_at IS NOT NULL)),
  UNIQUE (event_id,key_hash),
  UNIQUE (event_id,code_hash),
  FOREIGN KEY (slot_id,event_id,organization_id,school_id) REFERENCES hon.school_event_slots(id,event_id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX school_event_bookings_one_email ON hon.school_event_bookings(event_id,email) WHERE status<>'CANCELLED' AND email IS NOT NULL;
CREATE UNIQUE INDEX school_event_bookings_one_mobile ON hon.school_event_bookings(event_id,mobile) WHERE status<>'CANCELLED' AND mobile IS NOT NULL;
CREATE INDEX school_event_bookings_slot_idx ON hon.school_event_bookings(slot_id,status);

-- E7: hourly public attempt counters per event and bucket (bucket names are fixed words or keyed hashes, never raw contact).
CREATE TABLE hon.school_event_rates (
  event_id uuid NOT NULL REFERENCES hon.school_events(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket IN ('BOOK_ATTEMPTS','CANCEL_ATTEMPTS') OR bucket ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1001),
  PRIMARY KEY (event_id,bucket)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_events','school_event_slots','school_event_bookings','school_event_rates'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;
CREATE TRIGGER school_events_no_truncate BEFORE TRUNCATE ON hon.school_events FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_event_slots_no_truncate BEFORE TRUNCATE ON hon.school_event_slots FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_event_slots_immutable BEFORE UPDATE OR DELETE ON hon.school_event_slots FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_event_bookings_no_truncate BEFORE TRUNCATE ON hon.school_event_bookings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

CREATE FUNCTION hon.guard_school_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_EVENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'DRAFT' THEN RAISE EXCEPTION 'SCHOOL_EVENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.public_id,NEW.hash_secret,NEW.actor_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.public_id,OLD.hash_secret,OLD.actor_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 OR OLD.status='CANCELLED'
    OR (OLD.status<>'DRAFT' AND (NEW.status='DRAFT' OR (NEW.local_date,NEW.opens_at,NEW.closes_at,NEW.slot_minutes)
      IS DISTINCT FROM (OLD.local_date,OLD.opens_at,OLD.closes_at,OLD.slot_minutes))) THEN
    RAISE EXCEPTION 'SCHOOL_EVENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_events_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_events FOR EACH ROW EXECUTE FUNCTION hon.guard_school_event();

CREATE FUNCTION hon.guard_school_event_booking() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_EVENT_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'BOOKED' THEN RAISE EXCEPTION 'SCHOOL_EVENT_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.event_id,NEW.slot_id,NEW.organization_id,NEW.school_id,NEW.family_name,NEW.email,NEW.mobile,NEW.key_hash,NEW.payload_hash,NEW.code_hash,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.event_id,OLD.slot_id,OLD.organization_id,OLD.school_id,OLD.family_name,OLD.email,OLD.mobile,OLD.key_hash,OLD.payload_hash,OLD.code_hash,OLD.created_at)
    OR NEW.version<>OLD.version+1
    OR NOT ((OLD.status,NEW.status) IN (('BOOKED','ARRIVED'),('BOOKED','CANCELLED'),('ARRIVED','BOOKED'))) THEN
    RAISE EXCEPTION 'SCHOOL_EVENT_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_event_bookings_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_event_bookings FOR EACH ROW EXECUTE FUNCTION hon.guard_school_event_booking();

-- Live spots taken in one slot.
CREATE FUNCTION hon.school_event_slot_taken(slot uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT count(*)::integer FROM hon.school_event_bookings b WHERE b.slot_id=slot AND b.status<>'CANCELLED'
$$;

CREATE FUNCTION hon.school_event_json(x hon.school_events) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('eventId',x.id,'publicId',x.public_id,'title',x.title,'description',x.description,'place',x.place,
    'localDate',to_char(x.local_date,'YYYY-MM-DD'),'opensAt',to_char(x.opens_at,'HH24:MI'),'closesAt',to_char(x.closes_at,'HH24:MI'),
    'slotMinutes',x.slot_minutes,'spotsPerSlot',x.spots_per_slot,'status',x.status,'version',x.version,
    'slotCount',(SELECT count(*) FROM hon.school_event_slots s WHERE s.event_id=x.id)::integer,
    'bookedCount',(SELECT count(*) FROM hon.school_event_bookings b WHERE b.event_id=x.id AND b.status<>'CANCELLED')::integer,
    'createdAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

CREATE FUNCTION hon.school_event_booking_json(b hon.school_event_bookings) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('bookingId',b.id,'slotId',b.slot_id,'name',b.family_name,'email',b.email,'mobile',b.mobile,'status',b.status,
    'cancelledBy',b.cancelled_by,'version',b.version,'createdAt',to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- Staff input for create/edit: {expectedVersion,title,description,place,localDate,opensAt,closesAt,slotMinutes,spotsPerSlot}.
CREATE FUNCTION hon.school_event_input(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE k text; opens time; closes time;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>4096
    OR NOT p ?& ARRAY['expectedVersion','title','description','place','localDate','opensAt','closesAt','slotMinutes','spotsPerSlot']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','title','description','place','localDate','opensAt','closesAt','slotMinutes','spotsPerSlot'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p->'slotMinutes') IS DISTINCT FROM 'number' OR (p->>'slotMinutes') !~ '^[1-9][0-9]{1,2}$' OR (p->>'slotMinutes')::integer NOT BETWEEN 10 AND 240
    OR jsonb_typeof(p->'spotsPerSlot') IS DISTINCT FROM 'number' OR (p->>'spotsPerSlot') !~ '^[1-9][0-9]{0,2}$' OR (p->>'spotsPerSlot')::integer NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOREACH k IN ARRAY ARRAY['title','description','place'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string'
      OR NOT hon.school_event_text_ok(p->>k,CASE k WHEN 'title' THEN 1 ELSE 0 END,CASE k WHEN 'description' THEN 500 ELSE 120 END) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['opensAt','closesAt'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR (p->>k) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  opens:=(p->>'opensAt')::time; closes:=(p->>'closesAt')::time;
  IF closes<=opens OR closes-opens<make_interval(mins=>(p->>'slotMinutes')::integer) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('expectedVersion',(p->>'expectedVersion')::integer,'title',p->>'title','description',p->>'description','place',p->>'place',
    'localDate',to_char(hon.membership_pause_date(p->'localDate'),'YYYY-MM-DD'),'opensAt',p->>'opensAt','closesAt',p->>'closesAt',
    'slotMinutes',(p->>'slotMinutes')::integer,'spotsPerSlot',(p->>'spotsPerSlot')::integer);
END $$;

CREATE FUNCTION hon.school_event_command_finish(subject text,key text,actor uuid,result jsonb,action text,entity_type text,entity uuid,
  prior_state jsonb,next_state jsonb,event_type text,entity_version integer,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF entity_type NOT IN ('SCHOOL_EVENT','SCHOOL_EVENT_BOOKING') THEN RAISE EXCEPTION 'SCHOOL_EVENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity_type,entity,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event_type,1,entity_type,entity,entity_version,correlation,request,next_state);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_EVENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- E1: create (selected NULL, expectedVersion 0) or edit an event. A published or closed event keeps its date and times.
CREATE FUNCTION hon.save_school_event(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; v jsonb;
  x hon.school_events%ROWTYPE; prior jsonb; result jsonb; today date; most integer;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v:=hon.school_event_input(p);
  IF (selected IS NULL)<>((v->>'expectedVersion')::integer=0) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.event.save','eventId',selected,'input',v)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  today:=hon.membership_school_today();
  IF selected IS NULL THEN
    IF (v->>'localDate')::date<today OR (v->>'localDate')::date>today+365 THEN RAISE EXCEPTION 'SCHOOL_EVENT_DATE_OUT_OF_RANGE' USING ERRCODE='22023'; END IF;
    INSERT INTO hon.school_events(organization_id,school_id,title,description,place,local_date,opens_at,closes_at,slot_minutes,spots_per_slot,actor_principal_id)
      VALUES(org,school,v->>'title',v->>'description',v->>'place',(v->>'localDate')::date,(v->>'opensAt')::time,(v->>'closesAt')::time,
        (v->>'slotMinutes')::integer,(v->>'spotsPerSlot')::integer,actor) RETURNING * INTO x;
    prior:=NULL;
  ELSE
    SELECT * INTO x FROM hon.school_events e WHERE e.id=selected AND e.organization_id=org AND e.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_EVENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF x.version<>(v->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF x.status='CANCELLED' THEN RAISE EXCEPTION 'SCHOOL_EVENT_CANCELLED' USING ERRCODE='40001'; END IF;
    prior:=hon.school_event_json(x);
    IF x.status='DRAFT' THEN
      IF (v->>'localDate')::date<today OR (v->>'localDate')::date>today+365 THEN RAISE EXCEPTION 'SCHOOL_EVENT_DATE_OUT_OF_RANGE' USING ERRCODE='22023'; END IF;
    ELSE
      IF ((v->>'localDate')::date,(v->>'opensAt')::time,(v->>'closesAt')::time,(v->>'slotMinutes')::integer)
          IS DISTINCT FROM (x.local_date,x.opens_at,x.closes_at,x.slot_minutes) THEN
        RAISE EXCEPTION 'SCHOOL_EVENT_SCHEDULE_LOCKED' USING ERRCODE='40001'; END IF;
      PERFORM 1 FROM hon.school_event_slots s WHERE s.event_id=x.id ORDER BY s.id FOR UPDATE;
      SELECT coalesce(max(hon.school_event_slot_taken(s.id)),0) INTO most FROM hon.school_event_slots s WHERE s.event_id=x.id;
      IF (v->>'spotsPerSlot')::integer<most THEN RAISE EXCEPTION 'SCHOOL_EVENT_SPOTS_BELOW_BOOKED' USING ERRCODE='40001'; END IF;
    END IF;
    UPDATE hon.school_events SET title=v->>'title',description=v->>'description',place=v->>'place',local_date=(v->>'localDate')::date,
      opens_at=(v->>'opensAt')::time,closes_at=(v->>'closesAt')::time,slot_minutes=(v->>'slotMinutes')::integer,
      spots_per_slot=(v->>'spotsPerSlot')::integer,version=version+1,updated_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x;
  END IF;
  result:=jsonb_build_object('event',hon.school_event_json(x),'skippedTimes','[]'::jsonb);
  PERFORM hon.school_event_command_finish(subject,key,actor,result,'schedule.event.save','SCHOOL_EVENT',x.id,prior,
    jsonb_build_object('eventId',x.id,'status',x.status,'version',x.version),'schedule.event.saved',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- E2/E3: publish (makes the slots the first time), close, reopen (PUBLISHED from CLOSED) or cancel.
CREATE FUNCTION hon.set_school_event_status(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  x hon.school_events%ROWTYPE; prior jsonb; result jsonb; target text; tz text; t time; m integer; starts timestamptz; pos integer:=0; skipped jsonb:='[]'::jsonb;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','status']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','status'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN ('PUBLISHED','CLOSED','CANCELLED')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=p->>'status';
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.event.status','eventId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO x FROM hon.school_events e WHERE e.id=selected AND e.organization_id=org AND e.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_EVENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF x.status='CANCELLED' THEN RAISE EXCEPTION 'SCHOOL_EVENT_CANCELLED' USING ERRCODE='40001'; END IF;
  IF NOT ((x.status,target) IN (('DRAFT','PUBLISHED'),('PUBLISHED','CLOSED'),('CLOSED','PUBLISHED'),('DRAFT','CANCELLED'),('PUBLISHED','CANCELLED'),('CLOSED','CANCELLED'))) THEN
    RAISE EXCEPTION 'SCHOOL_EVENT_STATUS_INVALID' USING ERRCODE='40001'; END IF;
  prior:=hon.school_event_json(x);
  IF x.status='DRAFT' AND target='PUBLISHED' THEN
    IF x.local_date<hon.membership_school_today() THEN RAISE EXCEPTION 'SCHOOL_EVENT_DATE_OUT_OF_RANGE' USING ERRCODE='22023'; END IF;
    SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
    m:=0;
    WHILE make_interval(mins=>m+x.slot_minutes)<=x.closes_at-x.opens_at LOOP
      t:=x.opens_at+make_interval(mins=>m);
      starts:=(x.local_date+t) AT TIME ZONE tz;
      IF (starts AT TIME ZONE tz)::time<>t OR (starts AT TIME ZONE tz)::date<>x.local_date THEN
        skipped:=skipped||to_jsonb(to_char(t,'HH24:MI'));
      ELSIF pos<96 THEN
        INSERT INTO hon.school_event_slots(event_id,organization_id,school_id,position,local_start,local_end,starts_at,ends_at)
          VALUES(x.id,org,school,pos,t,t+make_interval(mins=>x.slot_minutes),starts,starts+make_interval(mins=>x.slot_minutes));
        pos:=pos+1;
      END IF;
      m:=m+x.slot_minutes;
    END LOOP;
    IF pos=0 OR NOT EXISTS(SELECT 1 FROM hon.school_event_slots s WHERE s.event_id=x.id AND s.starts_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'SCHOOL_EVENT_NO_SLOTS' USING ERRCODE='22023'; END IF;
  END IF;
  UPDATE hon.school_events SET status=target,version=version+1,updated_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x;
  result:=jsonb_build_object('event',hon.school_event_json(x),'skippedTimes',skipped);
  PERFORM hon.school_event_command_finish(subject,key,actor,result,'schedule.event.status','SCHOOL_EVENT',x.id,prior,
    jsonb_build_object('eventId',x.id,'status',x.status,'version',x.version),'schedule.event.status_set',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- E6: staff mark a booking arrived, undo arrived (BOOKED), or cancel it.
CREATE FUNCTION hon.set_school_event_booking_status(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  b hon.school_event_bookings%ROWTYPE; e hon.school_events%ROWTYPE; prior jsonb; result jsonb; target text;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','status']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','status'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN ('BOOKED','ARRIVED','CANCELLED')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=p->>'status';
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','schedule.event.booking.status','bookingId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.class_series_command_begin(subject,key,fp);
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO b FROM hon.school_event_bookings x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_EVENT_BOOKING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Lock order shared with the public paths: event -> slot -> booking.
  SELECT * INTO e FROM hon.school_events x WHERE x.id=b.event_id FOR SHARE;
  PERFORM 1 FROM hon.school_event_slots s WHERE s.id=b.slot_id FOR UPDATE;
  SELECT * INTO b FROM hon.school_event_bookings x WHERE x.id=selected FOR UPDATE;
  IF b.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NOT ((b.status,target) IN (('BOOKED','ARRIVED'),('BOOKED','CANCELLED'),('ARRIVED','BOOKED'))) THEN
    RAISE EXCEPTION 'SCHOOL_EVENT_BOOKING_STATUS_INVALID' USING ERRCODE='40001'; END IF;
  prior:=jsonb_build_object('bookingId',b.id,'status',b.status,'version',b.version);
  UPDATE hon.school_event_bookings SET status=target,version=version+1,updated_at=clock_timestamp(),
    arrived_at=CASE WHEN target='ARRIVED' THEN clock_timestamp() ELSE NULL END,
    cancelled_by=CASE WHEN target='CANCELLED' THEN 'STAFF' ELSE NULL END,
    cancelled_at=CASE WHEN target='CANCELLED' THEN clock_timestamp() ELSE NULL END
    WHERE id=b.id RETURNING * INTO b;
  result:=jsonb_build_object('booking',hon.school_event_booking_json(b));
  PERFORM hon.school_event_command_finish(subject,key,actor,result,'schedule.event.booking.status','SCHOOL_EVENT_BOOKING',b.id,prior,
    jsonb_build_object('bookingId',b.id,'eventId',b.event_id,'status',b.status,'version',b.version),'schedule.event.booking_status_set',b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Staff reads (schedule.session.manage: the bookings carry family contact details).
CREATE FUNCTION hon.read_school_events(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  result:=jsonb_build_object('localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'timezone',(SELECT s.timezone FROM hon.schools s WHERE s.id=hon.current_school_id()),
    'events',coalesce((SELECT jsonb_agg(hon.school_event_json(x) ORDER BY x.local_date DESC,x.opens_at,x.id) FROM (SELECT * FROM hon.school_events y
      WHERE y.organization_id=hon.current_organization_id() AND y.school_id=hon.current_school_id() ORDER BY y.local_date DESC,y.opens_at,y.id LIMIT 200) x),'[]'::jsonb));
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_EVENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION hon.read_school_event(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; x hon.school_events%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  SELECT * INTO x FROM hon.school_events e WHERE e.id=selected AND e.organization_id=hon.current_organization_id() AND e.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_EVENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('event',hon.school_event_json(x),
    'timezone',(SELECT s.timezone FROM hon.schools s WHERE s.id=x.school_id),
    'slots',coalesce((SELECT jsonb_agg(jsonb_build_object('slotId',s.id,'position',s.position,'localStart',to_char(s.local_start,'HH24:MI'),
      'localEnd',to_char(s.local_end,'HH24:MI'),'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'taken',hon.school_event_slot_taken(s.id),
      'bookings',coalesce((SELECT jsonb_agg(hon.school_event_booking_json(b) ORDER BY b.created_at,b.id) FROM hon.school_event_bookings b WHERE b.slot_id=s.id),'[]'::jsonb))
      ORDER BY s.position) FROM hon.school_event_slots s WHERE s.event_id=x.id),'[]'::jsonb));
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_EVENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- E7: one hourly counter per event and bucket.
CREATE FUNCTION hon.take_school_event_rate(ev uuid,bucket_name text,limit_count integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; asof timestamptz:=clock_timestamp();
BEGIN
  INSERT INTO hon.school_event_rates(event_id,bucket,window_start,attempts) VALUES(ev,bucket_name,asof,1)
  ON CONFLICT(event_id,bucket) DO UPDATE SET
    window_start=CASE WHEN hon.school_event_rates.window_start<=asof-interval '1 hour' THEN asof ELSE hon.school_event_rates.window_start END,
    attempts=CASE WHEN hon.school_event_rates.window_start<=asof-interval '1 hour' THEN 1 ELSE least(hon.school_event_rates.attempts+1,1001) END
  RETURNING attempts INTO n;
  RETURN n<=limit_count;
END $$;

-- The published event the public may see: PUBLISHED, CLOSED or CANCELLED, with a live school, organization and entitlement.
CREATE FUNCTION hon.public_school_event(pid text) RETURNS hon.school_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT e.* FROM hon.school_events e JOIN hon.organizations o ON o.id=e.organization_id JOIN hon.schools s ON s.id=e.school_id AND s.organization_id=e.organization_id
  WHERE pid ~ '^[a-f0-9]{48}$' AND e.public_id=pid AND e.status IN ('PUBLISHED','CLOSED','CANCELLED') AND o.status='ACTIVE' AND s.status='ACTIVE'
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements x WHERE x.organization_id=e.organization_id AND x.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND x.status='ACTIVE' AND x.effective_from<=clock_timestamp() AND (x.effective_until IS NULL OR x.effective_until>clock_timestamp()))
$$;

-- Public read: a whitelisted projection with open spots only.
CREATE FUNCTION hon.read_public_school_event(pid text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_events%ROWTYPE; tz text; school_name text;
BEGIN
  x:=hon.public_school_event(pid);
  IF x.id IS NULL THEN RETURN NULL; END IF;
  SELECT s.timezone,s.name INTO tz,school_name FROM hon.schools s WHERE s.id=x.school_id AND s.organization_id=x.organization_id;
  RETURN jsonb_build_object('publicId',x.public_id,'schoolName',school_name,'title',x.title,'description',x.description,'place',x.place,
    'localDate',to_char(x.local_date,'YYYY-MM-DD'),'timezone',tz,'status',CASE x.status WHEN 'PUBLISHED' THEN 'OPEN' ELSE x.status END,
    'slots',coalesce((SELECT jsonb_agg(jsonb_build_object('slotId',s.id,'localStart',to_char(s.local_start,'HH24:MI'),'localEnd',to_char(s.local_end,'HH24:MI'),
      'spotsLeft',CASE WHEN x.status='PUBLISHED' AND s.starts_at>clock_timestamp() THEN greatest(x.spots_per_slot-hon.school_event_slot_taken(s.id),0) ELSE 0 END)
      ORDER BY s.position) FROM hon.school_event_slots s WHERE s.event_id=x.id),'[]'::jsonb));
END $$;

-- Public booking input: {slotId,name,email,mobile,website}; website is a honeypot that must be empty.
CREATE FUNCTION hon.school_event_booking_input(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE nm text; email text; mobile text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>2048 OR NOT p ?& ARRAY['slotId','name','email','mobile','website']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('slotId','name','email','mobile','website'))
    OR jsonb_typeof(p->'slotId') IS DISTINCT FROM 'string' OR (p->>'slotId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'email') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'mobile') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'website') IS DISTINCT FROM 'string' OR p->>'website'<>'' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  nm:=p->>'name'; email:=lower(p->>'email'); mobile:=p->>'mobile';
  IF NOT hon.school_event_text_ok(nm,1,120) OR length(email)>254 OR length(mobile)>16
    OR (email<>'' AND email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$')
    OR (mobile<>'' AND mobile !~ '^\+[1-9][0-9]{6,14}$') OR (email='' AND mobile='') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('slotId',p->>'slotId','name',nm,'email',email,'mobile',mobile);
END $$;

-- E4: book. Returns {result} with result BOOKED (plus code and slot), INVALID, CLOSED, FULL, STARTED, ALREADY_BOOKED or RATE_LIMITED.
CREATE FUNCTION hon.book_public_school_event(pid text,p jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_events%ROWTYPE; v jsonb; kh text; ph text; code text; s hon.school_event_slots%ROWTYPE; b hon.school_event_bookings%ROWTYPE;
  contact text; request uuid:=gen_random_uuid();
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  x:=hon.public_school_event(pid);
  IF x.id IS NULL THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  -- Lock order: organization -> school -> event -> slot -> booking (the staff paths take event -> slot -> booking).
  PERFORM 1 FROM hon.organizations WHERE id=x.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  PERFORM 1 FROM hon.schools WHERE id=x.school_id AND organization_id=x.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  SELECT * INTO x FROM hon.school_events WHERE id=x.id FOR SHARE;
  PERFORM 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000261' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000261')
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000261')
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000261') THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  DELETE FROM hon.school_event_rates WHERE event_id=x.id AND window_start<=clock_timestamp()-interval '1 hour';
  IF NOT hon.take_school_event_rate(x.id,'BOOK_ATTEMPTS',1000) THEN RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  BEGIN v:=hon.school_event_booking_input(p); EXCEPTION WHEN SQLSTATE '22023' THEN RETURN jsonb_build_object('result','INVALID'); END;
  kh:=encode(sha256(convert_to(x.hash_secret||':key:'||key,'UTF8')),'hex');
  ph:=encode(sha256(convert_to(x.hash_secret||':payload:'||v::text,'UTF8')),'hex');
  code:=upper(substr(encode(sha256(convert_to(x.hash_secret||':code:'||kh,'UTF8')),'hex'),1,12));
  -- An exact retry returns the same booking and code, whatever has happened since.
  SELECT * INTO b FROM hon.school_event_bookings WHERE event_id=x.id AND key_hash=kh;
  IF FOUND THEN
    IF b.payload_hash<>ph THEN RETURN jsonb_build_object('result','INVALID'); END IF;
    SELECT * INTO s FROM hon.school_event_slots WHERE id=b.slot_id;
    RETURN jsonb_build_object('result','BOOKED','code',code,'slotId',s.id,'localStart',to_char(s.local_start,'HH24:MI'),'localEnd',to_char(s.local_end,'HH24:MI'),'status',b.status);
  END IF;
  FOREACH contact IN ARRAY ARRAY[nullif(v->>'email',''),nullif(v->>'mobile','')] LOOP
    IF contact IS NOT NULL AND NOT hon.take_school_event_rate(x.id,encode(sha256(convert_to(x.hash_secret||':contact:'||contact,'UTF8')),'hex'),5) THEN
      RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  END LOOP;
  IF x.status<>'PUBLISHED' THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  SELECT * INTO s FROM hon.school_event_slots WHERE id=(v->>'slotId')::uuid AND event_id=x.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  IF s.starts_at<=clock_timestamp() THEN RETURN jsonb_build_object('result','STARTED'); END IF;
  IF EXISTS(SELECT 1 FROM hon.school_event_bookings y WHERE y.event_id=x.id AND y.status<>'CANCELLED'
      AND ((v->>'email'<>'' AND y.email=v->>'email') OR (v->>'mobile'<>'' AND y.mobile=v->>'mobile'))) THEN
    RETURN jsonb_build_object('result','ALREADY_BOOKED'); END IF;
  IF hon.school_event_slot_taken(s.id)>=x.spots_per_slot THEN RETURN jsonb_build_object('result','FULL'); END IF;
  BEGIN
    INSERT INTO hon.school_event_bookings(event_id,slot_id,organization_id,school_id,family_name,email,mobile,key_hash,payload_hash,code_hash)
      VALUES(x.id,s.id,x.organization_id,x.school_id,v->>'name',nullif(v->>'email',''),nullif(v->>'mobile',''),kh,ph,
        encode(sha256(convert_to(x.hash_secret||':code-check:'||code,'UTF8')),'hex')) RETURNING * INTO b;
  EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result','ALREADY_BOOKED');
  END;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(x.organization_id,x.school_id,'00000000-0000-4000-8000-000000000261','PUBLIC_API','schedule.event.booking.create','SCHOOL_EVENT_BOOKING',b.id,
      jsonb_build_object('bookingId',b.id,'eventId',x.id,'slotId',s.id,'status',b.status,'version',1),'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(x.organization_id,x.school_id,'schedule.event.booking_created',1,'SCHOOL_EVENT_BOOKING',b.id,1,request,request,
      jsonb_build_object('bookingId',b.id,'eventId',x.id,'slotId',s.id,'internalOnly',true));
  RETURN jsonb_build_object('result','BOOKED','code',code,'slotId',s.id,'localStart',to_char(s.local_start,'HH24:MI'),'localEnd',to_char(s.local_end,'HH24:MI'),'status',b.status);
END $$;

-- E5: cancel with the booking code. Returns {result} CANCELLED, INVALID, STARTED or RATE_LIMITED.
CREATE FUNCTION hon.cancel_public_school_event_booking(pid text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_events%ROWTYPE; code text; b hon.school_event_bookings%ROWTYPE; s hon.school_event_slots%ROWTYPE; request uuid:=gen_random_uuid();
BEGIN
  IF pid IS NULL OR pid !~ '^[a-f0-9]{48}$' OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'code'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'code') OR jsonb_typeof(p->'code') IS DISTINCT FROM 'string' THEN
    RETURN jsonb_build_object('result','INVALID'); END IF;
  code:=upper(replace(p->>'code','-',''));
  IF code !~ '^[A-F0-9]{12}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  x:=hon.public_school_event(pid);
  IF x.id IS NULL THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  PERFORM 1 FROM hon.organizations WHERE id=x.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  PERFORM 1 FROM hon.schools WHERE id=x.school_id AND organization_id=x.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  SELECT * INTO x FROM hon.school_events WHERE id=x.id FOR SHARE;
  DELETE FROM hon.school_event_rates WHERE event_id=x.id AND window_start<=clock_timestamp()-interval '1 hour';
  IF NOT hon.take_school_event_rate(x.id,'CANCEL_ATTEMPTS',300) THEN RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  SELECT * INTO b FROM hon.school_event_bookings WHERE event_id=x.id AND code_hash=encode(sha256(convert_to(x.hash_secret||':code-check:'||code,'UTF8')),'hex');
  IF NOT FOUND THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  SELECT * INTO s FROM hon.school_event_slots WHERE id=b.slot_id FOR UPDATE;
  SELECT * INTO b FROM hon.school_event_bookings WHERE id=b.id FOR UPDATE;
  IF b.status='CANCELLED' THEN RETURN jsonb_build_object('result','CANCELLED'); END IF;
  IF b.status<>'BOOKED' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  IF s.starts_at<=clock_timestamp() THEN RETURN jsonb_build_object('result','STARTED'); END IF;
  UPDATE hon.school_event_bookings SET status='CANCELLED',cancelled_by='FAMILY',cancelled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=b.id RETURNING * INTO b;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(x.organization_id,x.school_id,'00000000-0000-4000-8000-000000000261','PUBLIC_API','schedule.event.booking.cancel','SCHOOL_EVENT_BOOKING',b.id,
      jsonb_build_object('bookingId',b.id,'eventId',x.id,'status',b.status,'version',b.version),'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(x.organization_id,x.school_id,'schedule.event.booking_cancelled',1,'SCHOOL_EVENT_BOOKING',b.id,b.version,request,request,
      jsonb_build_object('bookingId',b.id,'eventId',x.id,'internalOnly',true));
  RETURN jsonb_build_object('result','CANCELLED');
END $$;

COMMENT ON TABLE hon.school_events IS '0261 one-day school events with bookable time slots (B-SCH-3 E1-E3). Private.';
COMMENT ON TABLE hon.school_event_slots IS '0261 the slots publishing made. Immutable. Private.';
COMMENT ON TABLE hon.school_event_bookings IS '0261 family slot bookings with contact details (B-SCH-3 E4-E6). Never deleted. Private.';
COMMENT ON TABLE hon.school_event_rates IS '0261 hourly public attempt counters. Private.';
COMMENT ON FUNCTION hon.book_public_school_event(text,jsonb,text) IS
'Public no-account slot booking for a published school event (B-SCH-3 E4): one live booking per email and per mobile, spots per slot enforced under the slot lock, exact retry returns the same code. No message, charge, lead or AI.';

DO $$ DECLARE r text; t text; f text; fns text[]:=ARRAY['hon.school_event_text_ok(text,integer,integer)','hon.guard_school_event()',
    'hon.guard_school_event_booking()','hon.school_event_slot_taken(uuid)','hon.school_event_json(hon.school_events)',
    'hon.school_event_booking_json(hon.school_event_bookings)','hon.school_event_input(jsonb)',
    'hon.school_event_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
    'hon.save_school_event(text,uuid,jsonb,text,uuid,uuid)','hon.set_school_event_status(text,uuid,jsonb,text,uuid,uuid)',
    'hon.set_school_event_booking_status(text,uuid,jsonb,text,uuid,uuid)','hon.read_school_events(text)','hon.read_school_event(text,uuid)',
    'hon.take_school_event_rate(uuid,text,integer)','hon.public_school_event(text)','hon.read_public_school_event(text)',
    'hon.school_event_booking_input(jsonb)','hon.book_public_school_event(text,jsonb,text)','hon.cancel_public_school_event_booking(text,jsonb)']; BEGIN
  FOREACH t IN ARRAY ARRAY['school_events','school_event_slots','school_event_bookings','school_event_rates'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.save_school_event(text,uuid,jsonb,text,uuid,uuid),hon.set_school_event_status(text,uuid,jsonb,text,uuid,uuid),
      hon.set_school_event_booking_status(text,uuid,jsonb,text,uuid,uuid),hon.read_school_events(text),hon.read_school_event(text,uuid),
      hon.read_public_school_event(text),hon.book_public_school_event(text,jsonb,text),hon.cancel_public_school_event_booking(text,jsonb) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.school_events','SELECT') OR has_table_privilege('hon_runtime','hon.school_event_bookings','SELECT')
      OR has_table_privilege('hon_runtime','hon.school_event_slots','SELECT') OR has_table_privilege('hon_runtime','hon.school_event_rates','SELECT')) THEN
    RAISE EXCEPTION 'School event booking must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
