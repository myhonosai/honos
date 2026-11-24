BEGIN;

-- Staff shift schedule SH (0467, allocated 2026-11-17 as 0464 and renumbered above main ceiling 0466 per the ledger rule). Owner request (David, 2026-11-17): "staff doesn't have
-- scheduler for shifts and hour tracking". Verified on main a1d8d29: no shift, time clock or timesheet exists. Spec:
-- docs/architecture/STAFF_SHIFTS_AND_TIME_CLOCK.md. Rules:
--   S1  staff.shift.manage (OWNER by default, staff-assignable): add, change and cancel shifts for eligible staff at the
--       exact school, and see everyone's week. staff.shift.view_own (OWNER by default, staff-assignable): see only one's
--       own shifts. Owners give either to other roles with the Roles & permissions checklist (0412).
--   S2  A shift is one person, one school-local date, a start and end (same day, 15 minutes to 16 hours, end may be 24:00),
--       an optional position and note. Input is school-local; the database converts it with hon.schools.timezone.
--   S3  Scheduled shifts of one person never overlap (checked under a per-person advisory lock). A cancelled shift stays as
--       history and can no longer change. Shifts are never deleted; each change is the next version, audited, with an
--       inert outbox event. Commands are idempotent (exact replay, key reuse refused).
--   S4  Direct human only (HUMAN_USER, HUMAN_UI, no action request or delegation), live ESSENTIAL/CORE/COMPLETE access,
--       active school and organization; the actor is proved again after the locks. Nothing here sends a message, pays
--       anyone or runs AI. The runtime gains no table privilege, only EXECUTE on two entry points.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Staff shifts require a restricted runtime'; END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL OR to_regclass('hon.staff_planning_revisions') IS NULL THEN
    RAISE EXCEPTION '0467 requires 0077, 0154 and 0224'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('staff.shift.manage','Schedule staff shifts: add, change and cancel shifts for anyone at the school and see everyone''s week',true,true),
  ('staff.shift.view_own','See their own shifts',false,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE (code='staff.shift.manage' AND is_sensitive AND is_staff_assignable)
      OR (code='staff.shift.view_own' AND NOT is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'staff shift permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('staff.shift.manage','staff.shift.view_own') ON CONFLICT DO NOTHING;

-- Free text: trimmed, 1..max characters, no control, markup or invisible direction characters.
CREATE FUNCTION hon.staff_shift_text_ok(v jsonb,max_len integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(CASE jsonb_typeof(v) WHEN 'null' THEN true
    WHEN 'string' THEN length(v#>>'{}') BETWEEN 1 AND max_len AND btrim(v#>>'{}')=v#>>'{}'
      AND v#>>'{}' !~ '[[:cntrl:]<>​-‏‪-‮⁠-⁯﻿]'
    ELSE false END,false)
$$;
-- Minutes from midnight of HH:MM (end may be 24:00); null when malformed.
CREATE FUNCTION hon.staff_shift_minutes(t text,is_end boolean) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR (is_end AND t='24:00')
    THEN split_part(t,':',1)::integer*60+split_part(t,':',2)::integer END
$$;
CREATE FUNCTION hon.staff_shift_date_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND to_char(to_date(v#>>'{}','YYYY-MM-DD'),'YYYY-MM-DD')=v#>>'{}',false)
$$;

CREATE TABLE hon.staff_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  local_date date NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  timezone text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  position text,
  note text,
  status text NOT NULL CHECK (status IN ('SCHEDULED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id),
  CHECK (hon.staff_shift_minutes(end_time,true)-hon.staff_shift_minutes(start_time,false) BETWEEN 15 AND 960),
  CHECK (ends_at>starts_at AND ends_at-starts_at<=interval '17 hours'),
  CHECK (hon.staff_shift_text_ok(coalesce(to_jsonb(position),'null'::jsonb),40) AND hon.staff_shift_text_ok(coalesce(to_jsonb(note),'null'::jsonb),300))
);
CREATE INDEX staff_shifts_school_week ON hon.staff_shifts(organization_id,school_id,local_date);
CREATE INDEX staff_shifts_person_time ON hon.staff_shifts(principal_id,starts_at) WHERE status='SCHEDULED';
ALTER TABLE hon.staff_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.staff_shifts FORCE ROW LEVEL SECURITY;
-- No policies: reachable only through the fixed definer functions below.

-- Shifts are never deleted; scope, person, creator and creation time never change; a cancelled shift never changes again;
-- every update is the next version.
CREATE FUNCTION hon.guard_staff_shift() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'STAFF_SHIFT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'SCHEDULED' THEN RAISE EXCEPTION 'STAFF_SHIFT_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.created_by_principal_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.created_by_principal_id,OLD.created_at)
    OR OLD.status='CANCELLED' OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'STAFF_SHIFT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.staff_shifts FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_shift();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.staff_shifts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_staff_shift();

-- Live direct-human authority at the current school with the given shift permission and live paid or trial access.
-- Same identity rules as 0392/0459.
CREATE FUNCTION hon.require_staff_shift_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('staff.shift.manage','staff.shift.view_own')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'STAFF_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
  IF actor IS NULL THEN RAISE EXCEPTION 'STAFF_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.staff_shift_json(s hon.staff_shifts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('shiftId',s.id,'staffPrincipalId',s.principal_id,'date',to_char(s.local_date,'YYYY-MM-DD'),
    'start',s.start_time,'end',s.end_time,'startsAt',hon.saas_ts(s.starts_at),'endsAt',hon.saas_ts(s.ends_at),
    'position',s.position,'note',s.note,'status',s.status,'version',s.version,'updatedAt',hon.saas_ts(s.updated_at))
$$;

-- The display name staff pickers use (0404): never email, subject, roles or grants.
CREATE FUNCTION hon.staff_shift_display_name(p_principal uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT left(coalesce(nullif(btrim(p.display_name),''),nullif(btrim(u.display_name),''),'Staff member'),120)
    FROM hon.principals p LEFT JOIN hon.users u ON u.id=p.user_id WHERE p.id=p_principal
$$;

-- One Monday-to-Sunday week. Managers see every eligible staff member (and anyone with a shift that week) with their saved
-- weekly availability; everyone else with view_own sees only their own row. Cancelled shifts are included (the page hides
-- them by default).
CREATE FUNCTION hon.read_staff_shift_week(subject text,week_start date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; mode text; tz text; result jsonb;
  week_end date;
BEGIN
  IF week_start IS NULL OR extract(isodow FROM week_start)<>1 OR week_start NOT BETWEEN date '2000-01-03' AND date '2099-12-28' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  week_end:=week_start+7;
  BEGIN actor:=hon.require_staff_shift_actor(subject,'staff.shift.manage'); mode:='MANAGE';
  EXCEPTION WHEN insufficient_privilege THEN actor:=hon.require_staff_shift_actor(subject,'staff.shift.view_own'); mode:='OWN'; END;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  WITH people AS (
    SELECT DISTINCT x.id FROM (
      SELECT p.id FROM hon.principals p WHERE mode='MANAGE' AND p.principal_type='HUMAN_USER' AND p.is_active
        AND EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school
          AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
        AND hon.staff_member_eligible(p.id,org,school)
      UNION SELECT s.principal_id FROM hon.staff_shifts s WHERE mode='MANAGE' AND s.organization_id=org AND s.school_id=school
        AND s.local_date>=week_start AND s.local_date<week_end
      UNION SELECT actor) x
    WHERE mode='MANAGE' OR x.id=actor
  ), named AS (
    SELECT id,hon.staff_shift_display_name(id) AS name FROM people ORDER BY 2,1 LIMIT 200
  )
  SELECT jsonb_build_object('mode',mode,'weekStart',to_char(week_start,'YYYY-MM-DD'),'timezone',tz,
    'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('principalId',n.id,'displayName',n.name) ORDER BY n.name,n.id) FROM named n),'[]'::jsonb),
    'shifts',coalesce((SELECT jsonb_agg(hon.staff_shift_json(s) ORDER BY s.starts_at,s.id) FROM (
        SELECT * FROM hon.staff_shifts s WHERE s.organization_id=org AND s.school_id=school AND s.local_date>=week_start AND s.local_date<week_end
          AND s.principal_id IN (SELECT id FROM named) ORDER BY s.starts_at,s.id LIMIT 500) s),'[]'::jsonb),
    'availability',CASE WHEN mode<>'MANAGE' THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('principalId',a.principal_id,'windows',a.windows) ORDER BY a.principal_id)
      FROM (SELECT DISTINCT ON (pr.principal_id) pr.principal_id,r.payload->'windows' AS windows,r.payload AS payload
              FROM hon.staff_profiles pr JOIN hon.staff_planning_revisions r ON r.profile_id=pr.id AND r.organization_id=pr.organization_id AND r.school_id=pr.school_id
             WHERE pr.organization_id=org AND pr.school_id=school AND r.kind='AVAILABILITY' AND pr.principal_id IN (SELECT id FROM named)
             ORDER BY pr.principal_id,r.version DESC) a
      WHERE a.payload->>'status'='ACTIVE' AND jsonb_array_length(a.windows)>0 AND (a.payload->>'effectiveFrom')::date<week_end
        AND (a.payload->'endsOn'='null'::jsonb OR (a.payload->>'endsOn')::date>week_start)),'[]'::jsonb) END)
  INTO result;
  IF (SELECT CASE mode WHEN 'MANAGE' THEN hon.require_staff_shift_actor(subject,'staff.shift.manage') ELSE hon.require_staff_shift_actor(subject,'staff.shift.view_own') END)
     IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STAFF_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Add, change or cancel one shift. Input:
--   {shiftId|null, expectedVersion, staffPrincipalId, date, start, end, position|null, note|null, status}
-- A new shift has shiftId null, expectedVersion 0 and status SCHEDULED. A change keeps the same person.
CREATE FUNCTION hon.save_staff_shift(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; s hon.staff_shifts%ROWTYPE; before jsonb; result jsonb; tz text;
  target uuid; d date; start_m integer; end_m integer; starts timestamptz; ends timestamptz; action text; expected integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)
       IS DISTINCT FROM ARRAY['date','end','expectedVersion','note','position','shiftId','staffPrincipalId','start','status']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'shiftId')='null' OR (jsonb_typeof(p->'shiftId')='string' AND p->>'shiftId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR jsonb_typeof(p->'staffPrincipalId') IS DISTINCT FROM 'string' OR p->>'staffPrincipalId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT hon.staff_shift_date_ok(p->'date')
    OR jsonb_typeof(p->'start') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'end') IS DISTINCT FROM 'string'
    OR hon.staff_shift_minutes(p->>'start',false) IS NULL OR hon.staff_shift_minutes(p->>'end',true) IS NULL
    OR hon.staff_shift_minutes(p->>'end',true)-hon.staff_shift_minutes(p->>'start',false) NOT BETWEEN 15 AND 960
    OR NOT hon.staff_shift_text_ok(p->'position',40) OR NOT hon.staff_shift_text_ok(p->'note',300)
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('SCHEDULED','CANCELLED')
    OR (jsonb_typeof(p->'shiftId')='null' AND ((p->>'expectedVersion')::integer<>0 OR p->>'status'<>'SCHEDULED'))
    OR (jsonb_typeof(p->'shiftId')='string' AND (p->>'expectedVersion')::integer<1) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  d:=(p->>'date')::date; target:=(p->>'staffPrincipalId')::uuid; expected:=(p->>'expectedVersion')::integer;
  start_m:=hon.staff_shift_minutes(p->>'start',false); end_m:=hon.staff_shift_minutes(p->>'end',true);
  IF d NOT BETWEEN current_date-400 AND current_date+400 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','staff_shift.save','input',p)::text,'UTF8')),'hex');
  actor:=hon.require_staff_shift_actor(subject,'staff.shift.manage');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_staff_shift_actor(subject,'staff.shift.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STAFF_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('shift',prior.response_body,'replayed',true);
  END IF;
  -- One person's shifts change one save at a time, so two overlapping saves cannot both pass the overlap check.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.staff_shifts:'||target::text,0));
  SELECT s2.timezone INTO tz FROM hon.schools s2 WHERE s2.id=school AND s2.organization_id=org;
  starts:=(d::timestamp+make_interval(mins=>start_m)) AT TIME ZONE tz;
  ends:=(d::timestamp+make_interval(mins=>end_m)) AT TIME ZONE tz;
  IF jsonb_typeof(p->'shiftId')='string' THEN
    SELECT * INTO s FROM hon.staff_shifts x WHERE x.id=(p->>'shiftId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_SHIFT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF s.principal_id<>target THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    IF s.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF s.status='CANCELLED' THEN RAISE EXCEPTION 'STAFF_SHIFT_CANCELLED' USING ERRCODE='55000'; END IF;
  END IF;
  -- Scheduling (new or changed times) needs a person who is staff here now; cancelling never does.
  IF p->>'status'='SCHEDULED' AND NOT hon.staff_member_eligible(target,org,school) THEN
    RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  -- Only this organization's shifts count: one person may work for two organizations, and neither may see or block the other.
  IF p->>'status'='SCHEDULED' AND EXISTS (SELECT 1 FROM hon.staff_shifts o WHERE o.organization_id=org AND o.principal_id=target AND o.status='SCHEDULED'
      AND o.id IS DISTINCT FROM s.id AND o.starts_at<ends AND starts<o.ends_at) THEN
    RAISE EXCEPTION 'SHIFT_OVERLAP' USING ERRCODE='23P01'; END IF;
  IF s.id IS NULL THEN
    INSERT INTO hon.staff_shifts(organization_id,school_id,principal_id,local_date,start_time,end_time,timezone,starts_at,ends_at,position,note,status,
        created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,target,d,p->>'start',p->>'end',tz,starts,ends,p->>'position',p->>'note','SCHEDULED',actor,actor) RETURNING * INTO s;
    action:='staff_shift.create';
  ELSE
    before:=hon.staff_shift_json(s);
    IF p->>'status'='CANCELLED' THEN
      UPDATE hon.staff_shifts SET status='CANCELLED',version=s.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
        WHERE id=s.id RETURNING * INTO s;
      action:='staff_shift.cancel';
    ELSE
      UPDATE hon.staff_shifts SET local_date=d,start_time=p->>'start',end_time=p->>'end',timezone=tz,starts_at=starts,ends_at=ends,
          position=p->>'position',note=p->>'note',version=s.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
        WHERE id=s.id RETURNING * INTO s;
      action:='staff_shift.update';
    END IF;
  END IF;
  result:=hon.staff_shift_json(s);
  -- The audit keeps times, person, status and version; the free-text note and position stay only on the shift.
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'STAFF_SHIFT',s.id,before-'note'-'position',result-'note'-'position','SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'staff_shift.saved',1,'STAFF_SHIFT',s.id,s.version,correlation,request,
      jsonb_build_object('shiftId',s.id,'staffPrincipalId',s.principal_id,'version',s.version,'status',s.status));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_staff_shift_actor(subject,'staff.shift.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'STAFF_SHIFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('shift',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_staff_shift_week(text,date)','hon.save_staff_shift(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.staff_shift_text_ok(jsonb,integer)','hon.staff_shift_minutes(text,boolean)','hon.staff_shift_date_ok(jsonb)',
    'hon.guard_staff_shift()','hon.require_staff_shift_actor(text,text)','hon.staff_shift_json(hon.staff_shifts)','hon.staff_shift_display_name(uuid)'];
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE hon.staff_shifts FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.staff_shifts FROM %I',r); END LOOP;
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
