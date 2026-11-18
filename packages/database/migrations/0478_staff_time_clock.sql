BEGIN;

-- Staff time clock TC (0478, allocated 2026-11-17 as 0465, renumbered to 0468 and then 0478 above main ceiling 0474 per the ledger rule). Owner request (David, 2026-11-17): "staff doesn't have
-- scheduler for shifts and hour tracking". Builds on the shift schedule (0467). Spec: docs/architecture/STAFF_SHIFTS_AND_TIME_CLOCK.md.
-- Rules:
--   T1  staff.time.clock (OWNER by default, staff-assignable): clock oneself in and out at this school,
--       always at the database clock, never the device's. staff.timesheet.manage (sensitive, OWNER by default,
--       staff-assignable): see everyone's week, add a missed entry or fix one with a required reason, approve or reopen
--       one person's week.
--   T2  At most one open entry per person per school (partial unique index, per-person advisory lock). Hours only (owner
--       decision 2026-11-17): no breaks, no overtime rules, no pay. An entry is at most 24 hours; a clock-out after that is
--       refused and a manager fixes the entry. Entries never overlap for the same person at the school.
--   T3  Entries are never deleted; every change is the next version, audited, with an inert outbox event. Every manager
--       fix also writes an append-only revision (before, after, reason, who, when).
--   T4  An approved week (the person's Monday-to-Sunday school-local week) cannot be clocked into or fixed until it is
--       reopened. A week with an open entry cannot be approved.
--   T5  Direct human only (HUMAN_USER, HUMAN_UI, no action request or delegation), live ESSENTIAL/CORE/COMPLETE access,
--       active school and organization; the actor is proved again after the locks. HON totals hours but never
--       calculates pay, sends a message or runs AI. The runtime gains no table privilege, only EXECUTE on five entry points.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Staff time clock requires a restricted runtime'; END IF;
  IF to_regclass('hon.staff_shifts') IS NULL OR to_regprocedure('hon.staff_shift_display_name(uuid)') IS NULL
    OR to_regprocedure('hon.staff_shift_text_ok(jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION '0478 requires 0467'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('staff.time.clock','Clock in and out at the school',false,true),
  ('staff.timesheet.manage','Review, fix, approve and export everyone''s timesheets',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE (code='staff.time.clock' AND NOT is_sensitive AND is_staff_assignable)
      OR (code='staff.timesheet.manage' AND is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'staff time permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('staff.time.clock','staff.timesheet.manage') ON CONFLICT DO NOTHING;

-- School-local "YYYY-MM-DDTHH:MM" from a manager fix; real calendar dates only.
CREATE FUNCTION hon.staff_time_local_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND to_char(to_date(left(v#>>'{}',10),'YYYY-MM-DD'),'YYYY-MM-DD')=left(v#>>'{}',10),false)
$$;

CREATE TABLE hon.staff_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  local_date date NOT NULL,
  timezone text NOT NULL,
  clock_in_at timestamptz NOT NULL,
  clock_out_at timestamptz,
  origin text NOT NULL CHECK (origin IN ('CLOCK','MANAGER')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id),
  CHECK (clock_in_at=date_trunc('milliseconds',clock_in_at) AND (clock_out_at IS NULL OR clock_out_at=date_trunc('milliseconds',clock_out_at))),
  CHECK (clock_out_at IS NULL OR (clock_out_at>clock_in_at AND clock_out_at-clock_in_at<=interval '24 hours')),
  CHECK (local_date=(clock_in_at AT TIME ZONE timezone)::date)
);
CREATE UNIQUE INDEX staff_time_entries_one_open ON hon.staff_time_entries(organization_id,school_id,principal_id) WHERE clock_out_at IS NULL;
CREATE INDEX staff_time_entries_school_week ON hon.staff_time_entries(organization_id,school_id,local_date);
CREATE INDEX staff_time_entries_person_time ON hon.staff_time_entries(principal_id,clock_in_at);
ALTER TABLE hon.staff_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.staff_time_entries FORCE ROW LEVEL SECURITY;

CREATE TABLE hon.staff_time_entry_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  entry_version integer NOT NULL CHECK (entry_version BETWEEN 1 AND 999999999),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300 AND hon.staff_shift_text_ok(to_jsonb(reason),300)),
  before_state jsonb CHECK (before_state IS NULL OR jsonb_typeof(before_state)='object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (entry_id,organization_id,school_id) REFERENCES hon.staff_time_entries(id,organization_id,school_id) ON DELETE RESTRICT,
  UNIQUE (entry_id,entry_version)
);
ALTER TABLE hon.staff_time_entry_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.staff_time_entry_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE hon.staff_timesheet_weeks (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  week_start date NOT NULL CHECK (extract(isodow FROM week_start)=1),
  status text NOT NULL CHECK (status IN ('APPROVED','OPEN')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  decided_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,school_id,principal_id,week_start),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.staff_timesheet_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.staff_timesheet_weeks FORCE ROW LEVEL SECURITY;
-- No policies on any of the three tables: reachable only through the fixed definer functions below.

CREATE FUNCTION hon.guard_staff_time() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'STAFF_TIME_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='staff_time_entry_revisions' THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'STAFF_TIME_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'STAFF_TIME_IMMUTABLE' USING ERRCODE='42501'; END IF;
    IF TG_TABLE_NAME='staff_timesheet_weeks' THEN
      IF NEW.status<>'APPROVED' THEN RAISE EXCEPTION 'STAFF_TIME_IMMUTABLE' USING ERRCODE='42501'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='staff_time_entries' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.origin,NEW.created_by_principal_id,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.origin,OLD.created_by_principal_id,OLD.created_at)
      OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'STAFF_TIME_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSE
    IF (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.week_start) IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.week_start)
      OR NEW.status=OLD.status OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'STAFF_TIME_IMMUTABLE' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.staff_time_entries FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_time();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.staff_time_entries FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_staff_time();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.staff_time_entry_revisions FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_time();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.staff_time_entry_revisions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_staff_time();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.staff_timesheet_weeks FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_time();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.staff_timesheet_weeks FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_staff_time();

-- Live direct-human authority at the current school with the given time permission. Same identity rules as 0467.
CREATE FUNCTION hon.require_staff_time_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('staff.time.clock','staff.timesheet.manage')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'STAFF_TIME_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code=permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'STAFF_TIME_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.staff_time_entry_json(e hon.staff_time_entries) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('entryId',e.id,'staffPrincipalId',e.principal_id,'localDate',to_char(e.local_date,'YYYY-MM-DD'),
    'clockInAt',hon.saas_ts(e.clock_in_at),'clockOutAt',hon.saas_ts(e.clock_out_at),'origin',e.origin,'version',e.version,
    'workedMinutes',CASE WHEN e.clock_out_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM e.clock_out_at-e.clock_in_at)/60)::integer END,
    'updatedAt',hon.saas_ts(e.updated_at))
$$;
CREATE FUNCTION hon.staff_timesheet_week_json(org uuid,school uuid,person uuid,week date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('status',w.status,'version',w.version,'decidedAt',hon.saas_ts(w.decided_at))
    FROM hon.staff_timesheet_weeks w WHERE w.organization_id=org AND w.school_id=school AND w.principal_id=person AND w.week_start=week
$$;
CREATE FUNCTION hon.staff_time_week_of(d date) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT d-(extract(isodow FROM d)::integer-1) $$;
CREATE FUNCTION hon.staff_time_week_approved(org uuid,school uuid,person uuid,d date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.staff_timesheet_weeks w WHERE w.organization_id=org AND w.school_id=school AND w.principal_id=person
    AND w.week_start=hon.staff_time_week_of(d) AND w.status='APPROVED')
$$;

-- Reserve the idempotency key, lock the authority tables, prove the actor again. Returns the prior response on replay.
CREATE FUNCTION hon.staff_time_begin(subject text,permission text,operation text,p jsonb,key text,actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',operation,'input',p)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_staff_time_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STAFF_TIME_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  RETURN prior.response_body;
END $$;
CREATE FUNCTION hon.staff_time_finish(subject text,permission text,key text,actor uuid,result jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND principal_id=actor AND idempotency_key=key;
  IF hon.require_staff_time_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STAFF_TIME_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION hon.staff_time_record(action text,entity uuid,before jsonb,after jsonb,version integer,actor uuid,request uuid,correlation uuid,payload jsonb) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(hon.current_organization_id(),hon.current_school_id(),actor,'HUMAN_UI',action,
      CASE WHEN action LIKE 'staff_timesheet.%' THEN 'STAFF_TIMESHEET_WEEK' ELSE 'STAFF_TIME_ENTRY' END,entity,before,after,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(hon.current_organization_id(),hon.current_school_id(),
      CASE WHEN action LIKE 'staff_timesheet.%' THEN 'staff_timesheet.decided' ELSE 'staff_time_entry.saved' END,1,
      CASE WHEN action LIKE 'staff_timesheet.%' THEN 'STAFF_TIMESHEET_WEEK' ELSE 'STAFF_TIME_ENTRY' END,entity,version,correlation,request,payload);
$$;

-- Clock in or clock out for oneself, at the database clock. Input {action, expectedVersion}:
-- expectedVersion is 0 for CLOCK_IN and the open entry's version otherwise.
CREATE FUNCTION hon.staff_time_clock_punch(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; e hon.staff_time_entries%ROWTYPE;
  before jsonb; result jsonb; tz text; pt timestamptz; act text; expected integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['action','expectedVersion']
    OR jsonb_typeof(p->'action') IS DISTINCT FROM 'string' OR p->>'action' NOT IN ('CLOCK_IN','CLOCK_OUT')
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR ((p->>'action')='CLOCK_IN')<>((p->>'expectedVersion')::integer=0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  act:=p->>'action'; expected:=(p->>'expectedVersion')::integer;
  actor:=hon.require_staff_time_actor(subject,'staff.time.clock');
  prior:=hon.staff_time_begin(subject,'staff.time.clock','staff_time.punch',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('entry',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.staff_time:'||actor::text,0));
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  pt:=date_trunc('milliseconds',clock_timestamp());
  SELECT * INTO e FROM hon.staff_time_entries x WHERE x.organization_id=org AND x.school_id=school AND x.principal_id=actor AND x.clock_out_at IS NULL FOR UPDATE;
  IF act='CLOCK_IN' THEN
    IF FOUND THEN RAISE EXCEPTION 'TIME_CLOCK_STATE_CHANGED' USING ERRCODE='55000'; END IF;
    IF hon.staff_time_week_approved(org,school,actor,(pt AT TIME ZONE tz)::date) THEN RAISE EXCEPTION 'TIMESHEET_APPROVED' USING ERRCODE='55000'; END IF;
    IF EXISTS(SELECT 1 FROM hon.staff_time_entries o WHERE o.organization_id=org AND o.school_id=school AND o.principal_id=actor AND o.clock_out_at>pt) THEN
      RAISE EXCEPTION 'TIME_ENTRY_OVERLAP' USING ERRCODE='23P01'; END IF;
    INSERT INTO hon.staff_time_entries(organization_id,school_id,principal_id,local_date,timezone,clock_in_at,origin,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,actor,(pt AT TIME ZONE tz)::date,tz,pt,'CLOCK',actor,actor) RETURNING * INTO e;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'TIME_CLOCK_STATE_CHANGED' USING ERRCODE='55000'; END IF;
    IF e.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    before:=hon.staff_time_entry_json(e);
    IF pt<=e.clock_in_at OR pt-e.clock_in_at>interval '24 hours' THEN
      RAISE EXCEPTION 'TIME_ENTRY_TOO_LONG' USING ERRCODE='55000'; END IF;
    UPDATE hon.staff_time_entries SET clock_out_at=pt,version=e.version+1,
        updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=e.id RETURNING * INTO e;
  END IF;
  result:=hon.staff_time_entry_json(e);
  PERFORM hon.staff_time_record('staff_time.'||lower(act),e.id,before,result,e.version,actor,request,correlation,
    jsonb_build_object('entryId',e.id,'staffPrincipalId',e.principal_id,'version',e.version,'action',act));
  PERFORM hon.staff_time_finish(subject,'staff.time.clock',key,actor,result);
  RETURN jsonb_build_object('entry',result,'replayed',false);
END $$;

-- The signed-in person's clock: open entry, today's scheduled shifts, this school-local week's entries and approval.
CREATE FUNCTION hon.read_my_time_clock(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; tz text; now_at timestamptz:=clock_timestamp();
  today date; week date; result jsonb;
BEGIN
  actor:=hon.require_staff_time_actor(subject,'staff.time.clock');
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  today:=(now_at AT TIME ZONE tz)::date; week:=hon.staff_time_week_of(today);
  SELECT jsonb_build_object('timezone',tz,'now',hon.saas_ts(now_at),'weekStart',to_char(week,'YYYY-MM-DD'),
    'open',(SELECT hon.staff_time_entry_json(e) FROM hon.staff_time_entries e WHERE e.organization_id=org AND e.school_id=school AND e.principal_id=actor AND e.clock_out_at IS NULL),
    'todayShifts',coalesce((SELECT jsonb_agg(hon.staff_shift_json(s) ORDER BY s.starts_at,s.id) FROM (SELECT * FROM hon.staff_shifts s WHERE s.organization_id=org
      AND s.school_id=school AND s.principal_id=actor AND s.local_date=today AND s.status='SCHEDULED' ORDER BY s.starts_at,s.id LIMIT 10) s),'[]'::jsonb),
    'entries',coalesce((SELECT jsonb_agg(hon.staff_time_entry_json(e) ORDER BY e.clock_in_at,e.id) FROM (SELECT * FROM hon.staff_time_entries e
      WHERE e.organization_id=org AND e.school_id=school AND e.principal_id=actor AND e.local_date>=week AND e.local_date<week+7
      ORDER BY e.clock_in_at,e.id LIMIT 200) e),'[]'::jsonb),
    'approval',hon.staff_timesheet_week_json(org,school,actor,week)) INTO result;
  IF hon.require_staff_time_actor(subject,'staff.time.clock') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STAFF_TIME_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- One Monday-to-Sunday week of everyone's time: eligible staff and anyone with an entry that week, each with entries,
-- scheduled minutes (0467 shifts) and approval.
CREATE FUNCTION hon.read_staff_timesheet_week(subject text,week_start date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; tz text; result jsonb;
BEGIN
  IF week_start IS NULL OR extract(isodow FROM week_start)<>1 OR week_start NOT BETWEEN date '2000-01-03' AND date '2099-12-28' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_staff_time_actor(subject,'staff.timesheet.manage');
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  WITH people AS (
    SELECT p.id FROM hon.principals p WHERE p.principal_type='HUMAN_USER' AND p.is_active
      AND EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school
        AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
      AND hon.staff_member_eligible(p.id,org,school)
    UNION SELECT e.principal_id FROM hon.staff_time_entries e WHERE e.organization_id=org AND e.school_id=school
      AND e.local_date>=week_start AND e.local_date<week_start+7
  ), named AS (SELECT id,hon.staff_shift_display_name(id) AS name FROM people ORDER BY 2,1 LIMIT 200)
  SELECT jsonb_build_object('weekStart',to_char(week_start,'YYYY-MM-DD'),'timezone',tz,
    'people',coalesce((SELECT jsonb_agg(jsonb_build_object('principalId',n.id,'displayName',n.name,
      'scheduledMinutes',coalesce((SELECT floor(sum(extract(epoch FROM s.ends_at-s.starts_at))/60)::integer FROM hon.staff_shifts s
        WHERE s.organization_id=org AND s.school_id=school AND s.principal_id=n.id AND s.status='SCHEDULED' AND s.local_date>=week_start AND s.local_date<week_start+7),0),
      'approval',hon.staff_timesheet_week_json(org,school,n.id,week_start),
      'entries',coalesce((SELECT jsonb_agg(hon.staff_time_entry_json(e) ORDER BY e.clock_in_at,e.id) FROM (SELECT * FROM hon.staff_time_entries e
        WHERE e.organization_id=org AND e.school_id=school AND e.principal_id=n.id AND e.local_date>=week_start AND e.local_date<week_start+7
        ORDER BY e.clock_in_at,e.id LIMIT 200) e),'[]'::jsonb)) ORDER BY n.name,n.id) FROM named n),'[]'::jsonb))
  INTO result;
  IF hon.require_staff_time_actor(subject,'staff.timesheet.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STAFF_TIME_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- A manager adds a missed entry or fixes one (clock-in and clock-out times), with a reason. Input:
--   {entryId|null, expectedVersion, staffPrincipalId, clockIn, clockOut, reason}
-- Times are school-local YYYY-MM-DDTHH:MM. The entry must end by now, last at most 24 hours, and not overlap the person's
-- other entries at the school; neither its old nor its new week may be approved.
CREATE FUNCTION hon.save_staff_time_entry(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; e hon.staff_time_entries%ROWTYPE;
  before jsonb; result jsonb; tz text; target uuid; expected integer; cin timestamptz; cout timestamptz; d date;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)
       IS DISTINCT FROM ARRAY['clockIn','clockOut','entryId','expectedVersion','reason','staffPrincipalId']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'entryId')='null' OR (jsonb_typeof(p->'entryId')='string' AND p->>'entryId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR (jsonb_typeof(p->'entryId')='null')<>((p->>'expectedVersion')::integer=0)
    OR jsonb_typeof(p->'staffPrincipalId') IS DISTINCT FROM 'string' OR p->>'staffPrincipalId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT hon.staff_time_local_ok(p->'clockIn') OR NOT hon.staff_time_local_ok(p->'clockOut')
    OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR length(p->>'reason')<3 OR NOT hon.staff_shift_text_ok(p->'reason',300) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=(p->>'staffPrincipalId')::uuid; expected:=(p->>'expectedVersion')::integer;
  actor:=hon.require_staff_time_actor(subject,'staff.timesheet.manage');
  prior:=hon.staff_time_begin(subject,'staff.timesheet.manage','staff_time.entry.save',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('entry',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.staff_time:'||target::text,0));
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  cin:=(p->>'clockIn')::timestamp AT TIME ZONE tz; cout:=(p->>'clockOut')::timestamp AT TIME ZONE tz; d:=(cin AT TIME ZONE tz)::date;
  IF cout<=cin OR cout-cin>interval '24 hours' OR cout>clock_timestamp() OR d<current_date-400 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p->'entryId')='string' THEN
    SELECT * INTO e FROM hon.staff_time_entries x WHERE x.id=(p->>'entryId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TIME_ENTRY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF e.principal_id<>target THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    IF e.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF hon.staff_time_week_approved(org,school,target,e.local_date) THEN RAISE EXCEPTION 'TIMESHEET_APPROVED' USING ERRCODE='55000'; END IF;
  ELSIF NOT hon.staff_member_eligible(target,org,school) THEN RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  IF hon.staff_time_week_approved(org,school,target,d) THEN RAISE EXCEPTION 'TIMESHEET_APPROVED' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM hon.staff_time_entries o WHERE o.organization_id=org AND o.school_id=school AND o.principal_id=target
      AND o.id IS DISTINCT FROM e.id AND o.clock_in_at<cout AND cin<coalesce(o.clock_out_at,'infinity'::timestamptz)) THEN
    RAISE EXCEPTION 'TIME_ENTRY_OVERLAP' USING ERRCODE='23P01'; END IF;
  IF e.id IS NULL THEN
    INSERT INTO hon.staff_time_entries(organization_id,school_id,principal_id,local_date,timezone,clock_in_at,clock_out_at,origin,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,target,d,tz,cin,cout,'MANAGER',actor,actor) RETURNING * INTO e;
  ELSE
    before:=hon.staff_time_entry_json(e);
    UPDATE hon.staff_time_entries SET local_date=d,timezone=tz,clock_in_at=cin,clock_out_at=cout,version=e.version+1,
        updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=e.id RETURNING * INTO e;
  END IF;
  result:=hon.staff_time_entry_json(e);
  INSERT INTO hon.staff_time_entry_revisions(organization_id,school_id,entry_id,entry_version,actor_principal_id,reason,before_state,after_state)
    VALUES(org,school,e.id,e.version,actor,p->>'reason',before,result);
  PERFORM hon.staff_time_record(CASE WHEN before IS NULL THEN 'staff_time.entry_add' ELSE 'staff_time.entry_fix' END,e.id,before,result,e.version,actor,request,correlation,
    jsonb_build_object('entryId',e.id,'staffPrincipalId',e.principal_id,'version',e.version,'action',CASE WHEN before IS NULL THEN 'ADD' ELSE 'FIX' END));
  PERFORM hon.staff_time_finish(subject,'staff.timesheet.manage',key,actor,result);
  RETURN jsonb_build_object('entry',result,'replayed',false);
END $$;

-- Approve (lock) or reopen one person's week. Input {staffPrincipalId, weekStart, action APPROVE|REOPEN, expectedVersion}:
-- expectedVersion is the week's current version, 0 when it was never decided.
CREATE FUNCTION hon.set_staff_timesheet_week(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; w hon.staff_timesheet_weeks%ROWTYPE;
  before jsonb; result jsonb; target uuid; week date; expected integer; act text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['action','expectedVersion','staffPrincipalId','weekStart']
    OR jsonb_typeof(p->'action') IS DISTINCT FROM 'string' OR p->>'action' NOT IN ('APPROVE','REOPEN')
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR (p->>'action'='REOPEN' AND (p->>'expectedVersion')::integer<1)
    OR jsonb_typeof(p->'staffPrincipalId') IS DISTINCT FROM 'string' OR p->>'staffPrincipalId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT hon.staff_shift_date_ok(p->'weekStart') OR extract(isodow FROM (p->>'weekStart')::date)<>1 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=(p->>'staffPrincipalId')::uuid; week:=(p->>'weekStart')::date; expected:=(p->>'expectedVersion')::integer; act:=p->>'action';
  actor:=hon.require_staff_time_actor(subject,'staff.timesheet.manage');
  prior:=hon.staff_time_begin(subject,'staff.timesheet.manage','staff_timesheet.decide',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('approval',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.staff_time:'||target::text,0));
  IF NOT EXISTS(SELECT 1 FROM hon.principals x WHERE x.id=target AND x.principal_type='HUMAN_USER')
    OR NOT (hon.staff_member_eligible(target,org,school) OR EXISTS(SELECT 1 FROM hon.staff_time_entries e WHERE e.organization_id=org AND e.school_id=school
      AND e.principal_id=target AND e.local_date>=week AND e.local_date<week+7)) THEN
    RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  SELECT * INTO w FROM hon.staff_timesheet_weeks x WHERE x.organization_id=org AND x.school_id=school AND x.principal_id=target AND x.week_start=week FOR UPDATE;
  IF coalesce(w.version,0)<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF (act='APPROVE' AND w.status='APPROVED') OR (act='REOPEN' AND w.status IS DISTINCT FROM 'APPROVED') THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF act='APPROVE' AND EXISTS(SELECT 1 FROM hon.staff_time_entries e WHERE e.organization_id=org AND e.school_id=school AND e.principal_id=target
      AND e.local_date>=week AND e.local_date<week+7 AND e.clock_out_at IS NULL) THEN
    RAISE EXCEPTION 'TIMESHEET_HAS_OPEN_ENTRY' USING ERRCODE='55000'; END IF;
  IF w.version IS NULL THEN
    INSERT INTO hon.staff_timesheet_weeks(organization_id,school_id,principal_id,week_start,status,decided_by_principal_id)
      VALUES(org,school,target,week,'APPROVED',actor) RETURNING * INTO w;
  ELSE
    before:=jsonb_build_object('status',w.status,'version',w.version,'decidedAt',hon.saas_ts(w.decided_at));
    UPDATE hon.staff_timesheet_weeks SET status=CASE act WHEN 'APPROVE' THEN 'APPROVED' ELSE 'OPEN' END,version=w.version+1,
        decided_by_principal_id=actor,decided_at=clock_timestamp()
      WHERE organization_id=org AND school_id=school AND principal_id=target AND week_start=week RETURNING * INTO w;
  END IF;
  result:=jsonb_build_object('status',w.status,'version',w.version,'decidedAt',hon.saas_ts(w.decided_at));
  PERFORM hon.staff_time_record('staff_timesheet.'||lower(act),target,before,result||jsonb_build_object('weekStart',to_char(week,'YYYY-MM-DD')),w.version,actor,request,correlation,
    jsonb_build_object('staffPrincipalId',target,'weekStart',to_char(week,'YYYY-MM-DD'),'version',w.version,'status',w.status));
  PERFORM hon.staff_time_finish(subject,'staff.timesheet.manage',key,actor,result);
  RETURN jsonb_build_object('approval',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.staff_time_clock_punch(text,jsonb,text,uuid,uuid)','hon.read_my_time_clock(text)','hon.read_staff_timesheet_week(text,date)',
    'hon.save_staff_time_entry(text,jsonb,text,uuid,uuid)','hon.set_staff_timesheet_week(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.staff_time_local_ok(jsonb)','hon.guard_staff_time()','hon.require_staff_time_actor(text,text)',
    'hon.staff_time_entry_json(hon.staff_time_entries)','hon.staff_timesheet_week_json(uuid,uuid,uuid,date)',
    'hon.staff_time_week_of(date)','hon.staff_time_week_approved(uuid,uuid,uuid,date)','hon.staff_time_begin(text,text,text,jsonb,text,uuid)',
    'hon.staff_time_finish(text,text,text,uuid,jsonb)','hon.staff_time_record(text,uuid,jsonb,jsonb,integer,uuid,uuid,uuid,jsonb)'];
  tables text[]:=ARRAY['hon.staff_time_entries','hon.staff_time_entry_revisions','hon.staff_timesheet_weeks'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY helpers||entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;
COMMIT;
