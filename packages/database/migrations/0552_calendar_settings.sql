BEGIN;

-- 0552 calendar settings (owner David 2026-11-19, number assigned by the coordinator): Classes > Calendar gets Settings with
-- Block-out Dates, Share Links (public calendars per program or for a group of programs, with link, embed code and QR) and the
-- school's public address and phone. Spec: docs/architecture/CALENDAR_SETTINGS_AND_SHARE_LINKS.md.
--   S1  hon.calendar_share_settings: one row per school, address (0-200) and phone (0-40), version +1 per save.
--   S2  hon.calendar_block_outs: a label and a first/last school date (span <= 62 days, last >= today), ACTIVE -> REMOVED
--       (final), at most 100 ACTIVE per school. A block-out never cancels, moves or refuses a class: it marks closed days for
--       staff and hides those days' classes from shared calendars.
--   S3  hon.share_calendars: PROGRAM (one program, optional age range 0-99) or GROUP (2-20 live PROGRAM calendars of the school),
--       name, description, enabled; a 48-hex public id made once; ACTIVE -> DELETED (final); at most 40 ACTIVE per school.
--   S4  Staff reads and writes re-prove live schedule.session.manage (0239 actor rule) and again after the last write; writes are
--       idempotent per actor and key, audited and put on the outbox. The block-out read for the calendar uses schedule.session.read.
--   S5  hon.read_public_share_calendar: only an enabled, ACTIVE calendar of an active school and organization with a live
--       entitlement (the 0286 rule). A whitelisted projection: school name, address, phone, branding, the calendar, and either
--       the group's live enabled members (age range, upcoming count) or up to 200 class times in the next 28 days that are
--       SCHEDULED, not started, not a private lesson, not demo data and not on a block-out day, with open spots (0538 count).
-- No message, charge, CRM lead, booking, student record or AI. The runtime gains EXECUTE on the entry points only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Calendar settings require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Calendar settings require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.class_series_command_begin(text,text,text)') IS NULL
    OR to_regprocedure('hon.calendar_card_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.require_current_school_class_sessions_read_actor(text)') IS NULL
    OR to_regprocedure('hon.read_public_school_branding(uuid)') IS NULL OR to_regprocedure('hon.school_event_text_ok(text,integer,integer)') IS NULL
    OR to_regprocedure('hon.walkin_session_taken(uuid)') IS NULL OR to_regprocedure('hon.demo_data_is_demo(text,uuid)') IS NULL
    OR to_regprocedure('hon.membership_pause_date(jsonb)') IS NULL OR to_regprocedure('hon.membership_school_today()') IS NULL THEN
    RAISE EXCEPTION 'Calendar settings require 0224, 0239, 0261, 0285, 0459, 0537 and 0551';
  END IF;
  IF to_regclass('hon.share_calendars') IS NOT NULL THEN RAISE EXCEPTION 'Calendar settings already applied'; END IF;
END $$;

-- S1
CREATE TABLE hon.calendar_share_settings (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  address text NOT NULL DEFAULT '' CHECK (hon.school_event_text_ok(address,0,200)),
  phone text NOT NULL DEFAULT '' CHECK (phone='' OR phone ~ '^[0-9+() .-]{3,40}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

-- S2
CREATE TABLE hon.calendar_block_outs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  label text NOT NULL CHECK (hon.school_event_text_ok(label,1,80)),
  first_day date NOT NULL,
  last_day date NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REMOVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  CHECK (last_day>=first_day AND last_day-first_day<=62)
);
CREATE INDEX calendar_block_outs_school_idx ON hon.calendar_block_outs(organization_id,school_id,last_day) WHERE status='ACTIVE';

-- S3
CREATE TABLE hon.share_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24),'hex') CHECK (public_id ~ '^[a-f0-9]{48}$'),
  kind text NOT NULL CHECK (kind IN ('PROGRAM','GROUP')),
  name text NOT NULL CHECK (hon.school_event_text_ok(name,1,80)),
  description text NOT NULL DEFAULT '' CHECK (hon.school_event_text_ok(description,0,300)),
  program_id uuid,
  member_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(member_ids)='array' AND jsonb_array_length(member_ids)<=20),
  age_min integer CHECK (age_min BETWEEN 0 AND 99),
  age_max integer CHECK (age_max BETWEEN 0 AND 99),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DELETED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK ((kind='PROGRAM' AND program_id IS NOT NULL AND member_ids='[]'::jsonb)
    OR (kind='GROUP' AND program_id IS NULL AND age_min IS NULL AND age_max IS NULL AND jsonb_array_length(member_ids)>=2)),
  CHECK (age_min IS NULL OR age_max IS NULL OR age_min<=age_max)
);
CREATE INDEX share_calendars_school_idx ON hon.share_calendars(organization_id,school_id) WHERE status='ACTIVE';

ALTER TABLE hon.calendar_share_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.calendar_share_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.calendar_block_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.calendar_block_outs FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.share_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.share_calendars FORCE ROW LEVEL SECURITY;

-- Identity and creation facts never change, every change raises the version by one, a final state stays final, nothing is deleted.
CREATE FUNCTION hon.guard_calendar_settings() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE o jsonb; n jsonb; k text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CALENDAR_SETTINGS_IMMUTABLE' USING ERRCODE='55000'; END IF;
  o:=to_jsonb(OLD); n:=to_jsonb(NEW);
  FOREACH k IN ARRAY ARRAY['id','organization_id','school_id','public_id','kind','created_by_principal_id','created_at'] LOOP
    IF o ? k AND o->k IS DISTINCT FROM n->k THEN RAISE EXCEPTION 'CALENDAR_SETTINGS_IMMUTABLE' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF NEW.version<>OLD.version+1 OR (o->>'status') IN ('REMOVED','DELETED') THEN
    RAISE EXCEPTION 'CALENDAR_SETTINGS_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_share_settings_guard BEFORE UPDATE OR DELETE ON hon.calendar_share_settings FOR EACH ROW EXECUTE FUNCTION hon.guard_calendar_settings();
CREATE TRIGGER calendar_block_outs_guard BEFORE UPDATE OR DELETE ON hon.calendar_block_outs FOR EACH ROW EXECUTE FUNCTION hon.guard_calendar_settings();
CREATE TRIGGER share_calendars_guard BEFORE UPDATE OR DELETE ON hon.share_calendars FOR EACH ROW EXECUTE FUNCTION hon.guard_calendar_settings();
CREATE TRIGGER calendar_share_settings_no_truncate BEFORE TRUNCATE ON hon.calendar_share_settings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER calendar_block_outs_no_truncate BEFORE TRUNCATE ON hon.calendar_block_outs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER share_calendars_no_truncate BEFORE TRUNCATE ON hon.share_calendars FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Whether a school-local date is inside an ACTIVE block-out of the school.
CREATE FUNCTION hon.calendar_day_blocked(org uuid,school uuid,day date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.calendar_block_outs b WHERE b.organization_id=org AND b.school_id=school AND b.status='ACTIVE'
    AND day BETWEEN b.first_day AND b.last_day)
$$;

-- S5: the public class times of one program, soonest first.
CREATE FUNCTION hon.share_calendar_times(org uuid,school uuid,program uuid,tz text,max_rows integer) RETURNS SETOF hon.class_sessions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT cs.* FROM hon.class_sessions cs
  WHERE cs.organization_id=org AND cs.school_id=school AND cs.program_id=program AND cs.status='SCHEDULED'
    AND cs.session_kind<>'PRIVATE_LESSON' AND cs.starts_at>clock_timestamp() AND cs.starts_at<=clock_timestamp()+interval '28 days'
    AND NOT hon.demo_data_is_demo('class_sessions',cs.id) AND NOT hon.demo_data_is_demo('programs',cs.program_id)
    AND NOT hon.calendar_day_blocked(org,school,(cs.starts_at AT TIME ZONE tz)::date)
  ORDER BY cs.starts_at,cs.id LIMIT max_rows
$$;

CREATE FUNCTION hon.share_calendar_json(c hon.share_calendars) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('shareCalendarId',c.id,'publicId',c.public_id,'kind',c.kind,'name',c.name,'description',c.description,
    'programId',c.program_id,'programName',(SELECT left(g.name,120) FROM hon.programs g WHERE g.id=c.program_id),
    'memberIds',coalesce((SELECT jsonb_agg(m.value ORDER BY m.ordinality) FROM jsonb_array_elements(c.member_ids) WITH ORDINALITY m
      WHERE EXISTS(SELECT 1 FROM hon.share_calendars y WHERE y.id=(m.value#>>'{}')::uuid AND y.status='ACTIVE')),'[]'::jsonb),
    'ageMin',c.age_min,'ageMax',c.age_max,'enabled',c.enabled,'version',c.version,
    'upcomingCount',CASE WHEN c.kind='PROGRAM' THEN (SELECT count(*) FROM hon.share_calendar_times(c.organization_id,c.school_id,c.program_id,
      (SELECT sc.timezone FROM hon.schools sc WHERE sc.id=c.school_id),200) t)::integer END)
$$;

CREATE FUNCTION hon.calendar_block_out_json(b hon.calendar_block_outs) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('blockOutId',b.id,'label',b.label,'firstDate',to_char(b.first_day,'YYYY-MM-DD'),
    'lastDate',to_char(b.last_day,'YYYY-MM-DD'),'version',b.version)
$$;

CREATE FUNCTION hon.calendar_settings_fp(operation text,target uuid,p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('operation',operation,'target',target,'input',p)::text,'UTF8')),'hex')
$$;

CREATE FUNCTION hon.calendar_expected_version(p jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN (p->>'expectedVersion')::integer;
END $$;

-- S1: save the school's public address and phone. expectedVersion is null for the first save.
CREATE FUNCTION hon.save_calendar_share_settings(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; expected integer;
  s hon.calendar_share_settings%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','address','phone']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','address','phone'))
    OR jsonb_typeof(p->'address') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'phone') IS DISTINCT FROM 'string'
    OR NOT hon.school_event_text_ok(p->>'address',0,200) OR NOT (p->>'phone'='' OR (p->>'phone') ~ '^[0-9+() .-]{3,40}$') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=CASE WHEN p->'expectedVersion'='null'::jsonb THEN NULL ELSE hon.calendar_expected_version(p) END;
  replay:=hon.class_series_command_begin(subject,key,hon.calendar_settings_fp('schedule.calendar.settings.save',NULL,p));
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO s FROM hon.calendar_share_settings x WHERE x.school_id=school AND x.organization_id=org FOR UPDATE;
  IF FOUND IS DISTINCT FROM (expected IS NOT NULL) OR (FOUND AND s.version<>expected) THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF expected IS NULL THEN
    INSERT INTO hon.calendar_share_settings(school_id,organization_id,address,phone,created_by_principal_id,updated_by_principal_id)
      VALUES(school,org,p->>'address',p->>'phone',actor,actor) RETURNING * INTO s;
  ELSE
    prior:=jsonb_build_object('address',s.address,'phone',s.phone,'version',s.version);
    UPDATE hon.calendar_share_settings SET address=p->>'address',phone=p->>'phone',version=version+1,updated_by_principal_id=actor,
      updated_at=clock_timestamp() WHERE school_id=school AND organization_id=org RETURNING * INTO s;
  END IF;
  result:=jsonb_build_object('address',s.address,'phone',s.phone,'version',s.version);
  PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.settings.save','CALENDAR_SHARE_SETTINGS',school,prior,result,
    'schedule.calendar.settings.saved',s.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S2: add a block-out.
CREATE FUNCTION hon.save_calendar_block_out(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; first_day date; last_day date;
  b hon.calendar_block_outs%ROWTYPE; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['label','firstDate','lastDate']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('label','firstDate','lastDate'))
    OR jsonb_typeof(p->'label') IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(p->>'label',1,80) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  first_day:=hon.membership_pause_date(p->'firstDate'); last_day:=hon.membership_pause_date(p->'lastDate');
  IF last_day<first_day OR last_day-first_day>62 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  replay:=hon.class_series_command_begin(subject,key,hon.calendar_settings_fp('schedule.calendar.block_out.add',NULL,p));
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  IF last_day<hon.membership_school_today() THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM hon.schools sc WHERE sc.id=school AND sc.organization_id=org FOR UPDATE;
  IF (SELECT count(*) FROM hon.calendar_block_outs x WHERE x.organization_id=org AND x.school_id=school AND x.status='ACTIVE'
      AND x.last_day>=hon.membership_school_today())>=100 THEN
    RAISE EXCEPTION 'CALENDAR_SETTINGS_LIMIT' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.calendar_block_outs(organization_id,school_id,label,first_day,last_day,created_by_principal_id,updated_by_principal_id)
    VALUES(org,school,p->>'label',first_day,last_day,actor,actor) RETURNING * INTO b;
  result:=hon.calendar_block_out_json(b);
  PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.block_out.add','CALENDAR_BLOCK_OUT',b.id,NULL,result,
    'schedule.calendar.block_out.added',b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S2: remove a block-out (final).
CREATE FUNCTION hon.remove_calendar_block_out(subject text,target uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; expected integer;
  b hon.calendar_block_outs%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF target IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'expectedVersion'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'expectedVersion') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=hon.calendar_expected_version(p);
  replay:=hon.class_series_command_begin(subject,key,hon.calendar_settings_fp('schedule.calendar.block_out.remove',target,p));
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO b FROM hon.calendar_block_outs x WHERE x.id=target AND x.organization_id=org AND x.school_id=school AND x.status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CALENDAR_SETTINGS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  prior:=hon.calendar_block_out_json(b);
  UPDATE hon.calendar_block_outs SET status='REMOVED',version=version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
    WHERE id=b.id RETURNING * INTO b;
  result:=hon.calendar_block_out_json(b)||jsonb_build_object('status','REMOVED');
  PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.block_out.remove','CALENDAR_BLOCK_OUT',b.id,prior,result,
    'schedule.calendar.block_out.removed',b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S3: create (target null) or edit a share calendar. Input: expectedVersion (null to create), kind, name, description, programId,
-- memberIds, ageMin, ageMax, enabled. A PROGRAM calendar sends memberIds []; a GROUP sends programId, ageMin and ageMax null.
CREATE FUNCTION hon.save_share_calendar(subject text,target uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; expected integer;
  kind text; program uuid; members jsonb; age_lo integer; age_hi integer; c hon.share_calendars%ROWTYPE; prior jsonb; result jsonb;
  keys text[]:=ARRAY['expectedVersion','kind','name','description','programId','memberIds','ageMin','ageMax','enabled'];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(keys))
    OR jsonb_typeof(p->'kind') IS DISTINCT FROM 'string' OR p->>'kind' NOT IN ('PROGRAM','GROUP')
    OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(p->>'name',1,80)
    OR jsonb_typeof(p->'description') IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(p->>'description',0,300)
    OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'memberIds') IS DISTINCT FROM 'array'
    OR NOT (p->'programId'='null'::jsonb OR (jsonb_typeof(p->'programId')='string' AND p->>'programId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR NOT (p->'ageMin'='null'::jsonb OR (jsonb_typeof(p->'ageMin')='number' AND p->>'ageMin' ~ '^[0-9]{1,2}$'))
    OR NOT (p->'ageMax'='null'::jsonb OR (jsonb_typeof(p->'ageMax')='number' AND p->>'ageMax' ~ '^[0-9]{1,2}$'))
    OR (target IS NULL)<>(p->'expectedVersion'='null'::jsonb) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF target IS NOT NULL THEN expected:=hon.calendar_expected_version(p); END IF;
  kind:=p->>'kind';
  program:=CASE WHEN p->'programId'<>'null'::jsonb THEN (p->>'programId')::uuid END;
  age_lo:=CASE WHEN p->'ageMin'<>'null'::jsonb THEN (p->>'ageMin')::integer END;
  age_hi:=CASE WHEN p->'ageMax'<>'null'::jsonb THEN (p->>'ageMax')::integer END;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'memberIds') m WHERE jsonb_typeof(m)<>'string'
      OR m#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(d.x) ORDER BY d.o),'[]'::jsonb) INTO members
    FROM (SELECT lower(m.value#>>'{}') AS x,min(m.ordinality) AS o FROM jsonb_array_elements(p->'memberIds') WITH ORDINALITY m GROUP BY 1) d;
  IF jsonb_array_length(members)<>jsonb_array_length(p->'memberIds')
    OR (kind='PROGRAM' AND (program IS NULL OR members<>'[]'::jsonb OR (age_lo IS NOT NULL AND age_hi IS NOT NULL AND age_lo>age_hi)))
    OR (kind='GROUP' AND (program IS NOT NULL OR age_lo IS NOT NULL OR age_hi IS NOT NULL OR jsonb_array_length(members) NOT BETWEEN 2 AND 20)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  replay:=hon.class_series_command_begin(subject,key,hon.calendar_settings_fp('schedule.calendar.share.save',target,p));
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  PERFORM 1 FROM hon.schools sc WHERE sc.id=school AND sc.organization_id=org FOR UPDATE;
  IF program IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=program AND g.organization_id=org AND g.school_id=school
      AND g.status<>'CANCELLED' AND NOT hon.demo_data_is_demo('programs',g.id)) THEN
    RAISE EXCEPTION 'PROGRAM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF kind='GROUP' AND (SELECT count(*) FROM hon.share_calendars y WHERE y.organization_id=org AND y.school_id=school AND y.status='ACTIVE'
      AND y.kind='PROGRAM' AND members ? y.id::text)<>jsonb_array_length(members) THEN
    RAISE EXCEPTION 'CALENDAR_SETTINGS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF target IS NULL THEN
    IF (SELECT count(*) FROM hon.share_calendars y WHERE y.organization_id=org AND y.school_id=school AND y.status='ACTIVE')>=40 THEN
      RAISE EXCEPTION 'CALENDAR_SETTINGS_LIMIT' USING ERRCODE='54000'; END IF;
    INSERT INTO hon.share_calendars(organization_id,school_id,kind,name,description,program_id,member_ids,age_min,age_max,enabled,
      created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,kind,p->>'name',p->>'description',program,members,age_lo,age_hi,(p->>'enabled')::boolean,actor,actor) RETURNING * INTO c;
  ELSE
    SELECT * INTO c FROM hon.share_calendars y WHERE y.id=target AND y.organization_id=org AND y.school_id=school AND y.status='ACTIVE' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CALENDAR_SETTINGS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF c.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF c.kind<>kind OR members ? c.id::text THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    prior:=hon.share_calendar_json(c)-'upcomingCount';
    UPDATE hon.share_calendars SET name=p->>'name',description=p->>'description',program_id=program,member_ids=members,age_min=age_lo,age_max=age_hi,
      enabled=(p->>'enabled')::boolean,version=version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
      WHERE id=c.id RETURNING * INTO c;
  END IF;
  result:=hon.share_calendar_json(c)-'upcomingCount';
  PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.share.save','SHARE_CALENDAR',c.id,prior,result,
    'schedule.calendar.share.saved',c.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S3: delete a share calendar (final). Its link stops answering and groups no longer show it.
CREATE FUNCTION hon.delete_share_calendar(subject text,target uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; expected integer;
  c hon.share_calendars%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF target IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'expectedVersion'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'expectedVersion') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=hon.calendar_expected_version(p);
  replay:=hon.class_series_command_begin(subject,key,hon.calendar_settings_fp('schedule.calendar.share.delete',target,p));
  actor:=hon.require_class_series_actor(subject);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO c FROM hon.share_calendars y WHERE y.id=target AND y.organization_id=org AND y.school_id=school AND y.status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CALENDAR_SETTINGS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  prior:=hon.share_calendar_json(c)-'upcomingCount';
  UPDATE hon.share_calendars SET status='DELETED',enabled=false,version=version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
    WHERE id=c.id RETURNING * INTO c;
  result:=jsonb_build_object('shareCalendarId',c.id,'status','DELETED','version',c.version);
  PERFORM hon.calendar_card_command_finish(subject,key,actor,result,'schedule.calendar.share.delete','SHARE_CALENDAR',c.id,prior,result,
    'schedule.calendar.share.deleted',c.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- S4: the Settings tab read (managers only).
CREATE FUNCTION hon.read_calendar_settings(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; today date; s hon.calendar_share_settings%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_class_series_actor(subject);
  org:=hon.current_organization_id(); school:=hon.current_school_id(); today:=hon.membership_school_today();
  SELECT * INTO s FROM hon.calendar_share_settings x WHERE x.school_id=school AND x.organization_id=org;
  result:=jsonb_build_object('timezone',(SELECT sc.timezone FROM hon.schools sc WHERE sc.id=school AND sc.organization_id=org),
    'localToday',to_char(today,'YYYY-MM-DD'),
    'schoolName',(SELECT left(sc.name,120) FROM hon.schools sc WHERE sc.id=school AND sc.organization_id=org),
    'settings',jsonb_build_object('address',coalesce(s.address,''),'phone',coalesce(s.phone,''),'version',s.version),
    'programs',coalesce((SELECT jsonb_agg(jsonb_build_object('programId',g.id,'name',left(g.name,120)) ORDER BY g.name,g.id)
      FROM (SELECT * FROM hon.programs z WHERE z.organization_id=org AND z.school_id=school AND z.status<>'CANCELLED'
        AND NOT hon.demo_data_is_demo('programs',z.id) ORDER BY z.name,z.id LIMIT 200) g),'[]'::jsonb),
    'blockOuts',coalesce((SELECT jsonb_agg(hon.calendar_block_out_json(b) ORDER BY b.first_day,b.id)
      FROM hon.calendar_block_outs b WHERE b.organization_id=org AND b.school_id=school AND b.status='ACTIVE' AND b.last_day>=today-30),'[]'::jsonb),
    'shareCalendars',coalesce((SELECT jsonb_agg(hon.share_calendar_json(c) ORDER BY c.kind DESC,c.name,c.id)
      FROM hon.share_calendars c WHERE c.organization_id=org AND c.school_id=school AND c.status='ACTIVE'),'[]'::jsonb));
  IF hon.require_class_series_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLASS_SERIES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- S4: closed days for the calendar view, overlapping up to 43 school-local days (anyone who can read the calendar).
CREATE FUNCTION hon.read_school_calendar_block_outs(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; from_day date; to_day date; result jsonb;
BEGIN
  actor:=hon.require_current_school_class_sessions_read_actor(subject);
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['from','to'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('from','to')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  from_day:=hon.membership_pause_date(p->'from'); to_day:=hon.membership_pause_date(p->'to');
  IF to_day<from_day OR to_day-from_day>42 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  result:=jsonb_build_object('blockOuts',coalesce((SELECT jsonb_agg(hon.calendar_block_out_json(b) ORDER BY b.first_day,b.id)
    FROM hon.calendar_block_outs b WHERE b.organization_id=org AND b.school_id=school AND b.status='ACTIVE'
      AND b.first_day<=to_day AND b.last_day>=from_day),'[]'::jsonb));
  IF hon.require_current_school_class_sessions_read_actor(subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- S5: the calendar the public may see.
CREATE FUNCTION hon.public_share_calendar(pid text) RETURNS hon.share_calendars
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT c.* FROM hon.share_calendars c JOIN hon.organizations o ON o.id=c.organization_id
    JOIN hon.schools s ON s.id=c.school_id AND s.organization_id=c.organization_id
  WHERE pid ~ '^[a-f0-9]{48}$' AND c.public_id=pid AND c.status='ACTIVE' AND c.enabled AND o.status='ACTIVE' AND s.status='ACTIVE'
    AND (c.kind='GROUP' OR (NOT hon.demo_data_is_demo('programs',c.program_id)
      AND EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=c.program_id AND g.status<>'CANCELLED')))
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements x WHERE x.organization_id=c.organization_id AND x.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND x.status='ACTIVE' AND x.effective_from<=clock_timestamp() AND (x.effective_until IS NULL OR x.effective_until>clock_timestamp()))
$$;

-- S5: the public read. Null for anything the public may not see.
CREATE FUNCTION hon.read_public_share_calendar(pid text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.share_calendars%ROWTYPE; tz text; branding jsonb; s hon.calendar_share_settings%ROWTYPE;
BEGIN
  c:=hon.public_share_calendar(pid);
  IF c.id IS NULL THEN RETURN NULL; END IF;
  SELECT sc.timezone INTO tz FROM hon.schools sc WHERE sc.id=c.school_id AND sc.organization_id=c.organization_id;
  branding:=hon.read_public_school_branding(c.school_id);
  IF branding IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM hon.calendar_share_settings x WHERE x.school_id=c.school_id AND x.organization_id=c.organization_id;
  RETURN jsonb_build_object('publicId',c.public_id,'kind',c.kind,'name',c.name,'description',c.description,'timezone',tz,
    'school',jsonb_build_object('name',branding->>'schoolName','address',coalesce(s.address,''),'phone',coalesce(s.phone,''),
      'logoUrl',branding->'logoUrl','accentColor',branding->'accentColor','contactLine',branding->'contactLine'),
    'ageMin',c.age_min,'ageMax',c.age_max,
    'calendars',CASE WHEN c.kind='GROUP' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('publicId',y.public_id,'name',y.name,
        'description',y.description,'ageMin',y.age_min,'ageMax',y.age_max,
        'upcomingCount',(SELECT count(*) FROM hon.share_calendar_times(y.organization_id,y.school_id,y.program_id,tz,200) t)::integer) ORDER BY m.ordinality)
      FROM jsonb_array_elements_text(c.member_ids) WITH ORDINALITY m JOIN hon.share_calendars y ON y.id=m.value::uuid
      WHERE y.organization_id=c.organization_id AND y.school_id=c.school_id AND y.status='ACTIVE' AND y.enabled AND y.kind='PROGRAM'
        AND NOT hon.demo_data_is_demo('programs',y.program_id)
        AND EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=y.program_id AND g.status<>'CANCELLED')),'[]'::jsonb) ELSE '[]'::jsonb END,
    'times',CASE WHEN c.kind='PROGRAM' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('name',t.name,
        'startsAt',to_char(t.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt',to_char(t.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'localDate',to_char(t.starts_at AT TIME ZONE tz,'YYYY-MM-DD'),'localStart',to_char(t.starts_at AT TIME ZONE tz,'HH24:MI'),
        'localEnd',to_char(t.ends_at AT TIME ZONE tz,'HH24:MI'),'room',coalesce(t.room_name,''),
        'spotsLeft',greatest(t.capacity-hon.walkin_session_taken(t.id),0)) ORDER BY t.starts_at,t.id)
      FROM hon.share_calendar_times(c.organization_id,c.school_id,c.program_id,tz,200) t),'[]'::jsonb) ELSE '[]'::jsonb END);
END $$;

COMMENT ON TABLE hon.calendar_share_settings IS '0552 S1 the school''s public address and phone for shared calendars. Private; definer access only.';
COMMENT ON TABLE hon.calendar_block_outs IS '0552 S2 closed days. Never cancels or refuses a class; hides the days from shared calendars. Private.';
COMMENT ON TABLE hon.share_calendars IS '0552 S3 public calendars (one program, or a group of program calendars). Private; definer access only.';
COMMENT ON FUNCTION hon.read_public_share_calendar(text) IS
'Public read of one enabled shared calendar (0552 S5): school name, address, phone, branding, group cards or up to 200 class times in 28 days with open spots. No student, family, staff or booking data. No DML.';

DO $$ DECLARE r text; col text; f text; t text;
  tables text[]:=ARRAY['calendar_share_settings','calendar_block_outs','share_calendars'];
  fns text[]:=ARRAY['hon.guard_calendar_settings()','hon.calendar_day_blocked(uuid,uuid,date)',
    'hon.share_calendar_times(uuid,uuid,uuid,text,integer)','hon.share_calendar_json(hon.share_calendars)',
    'hon.calendar_block_out_json(hon.calendar_block_outs)','hon.calendar_settings_fp(text,uuid,jsonb)','hon.calendar_expected_version(jsonb)',
    'hon.public_share_calendar(text)',
    'hon.save_calendar_share_settings(text,jsonb,text,uuid,uuid)','hon.save_calendar_block_out(text,jsonb,text,uuid,uuid)',
    'hon.remove_calendar_block_out(text,uuid,jsonb,text,uuid,uuid)','hon.save_share_calendar(text,uuid,jsonb,text,uuid,uuid)',
    'hon.delete_share_calendar(text,uuid,jsonb,text,uuid,uuid)','hon.read_calendar_settings(text)',
    'hon.read_school_calendar_block_outs(text,jsonb)','hon.read_public_share_calendar(text)']; BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.save_calendar_share_settings(text,jsonb,text,uuid,uuid),hon.save_calendar_block_out(text,jsonb,text,uuid,uuid),
      hon.remove_calendar_block_out(text,uuid,jsonb,text,uuid,uuid),hon.save_share_calendar(text,uuid,jsonb,text,uuid,uuid),
      hon.delete_share_calendar(text,uuid,jsonb,text,uuid,uuid),hon.read_calendar_settings(text),
      hon.read_school_calendar_block_outs(text,jsonb),hon.read_public_share_calendar(text) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.share_calendars','SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('hon_runtime','hon.calendar_block_outs','SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('hon_runtime','hon.calendar_share_settings','SELECT,INSERT,UPDATE,DELETE')
      OR has_function_privilege('hon_runtime','hon.public_share_calendar(text)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.share_calendar_times(uuid,uuid,uuid,text,integer)','EXECUTE')) THEN
    RAISE EXCEPTION 'Calendar settings must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
