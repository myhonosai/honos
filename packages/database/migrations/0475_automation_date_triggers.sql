BEGIN;

-- AU-3 (0475): date-based automation triggers. Design: docs/superpowers/specs/2026-11-15-automation-builder-design.md (5.3).
-- - Three triggers become runnable: ABSENT_DAYS (an active student has not attended for N days), BIRTHDAY (a student's
--   birthday is N days away or today) and MEMBERSHIP_ENDS_IN_DAYS (an active membership's term ends within N days).
-- - The engine role (hon_automation_worker, infra/postgres/014) gains one fixed function, scan_automation_schedules. It looks
--   at each workflow with one of these triggers once per school-local day, at or after 09:00 school time, and starts runs
--   through the same 0423 automation_start_run (one open run per contact, reentry rule, 500 runs per workflow per day,
--   entry conditions). Each scan is receipted once per workflow and local date; a failed scan is receipted by name and
--   starts nothing.
-- - One run per subject: an absence episode (the last attendance, else the membership when the student never attended),
--   a birthday year, or a membership term end. A scan that is missed (worker off) catches up the next time it runs:
--   a birthday still ahead within the window, a term end still ahead within the window, a student still absent.
-- - Authority is re-proved before each workflow is scanned; if the activator no longer may, the workflow pauses with
--   AUTHORITY_LOST and nothing starts. Steps still run through run_due_automation_steps with every 0423 rail.
-- - SCHEDULE (dated or weekly sends to an audience) and CUSTOM_TOOL_RECORD stay refused by name.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.run_due_automation_steps(integer)') IS NULL
    OR to_regprocedure('hon.automation_start_run(hon.automation_workflows,uuid,text,uuid,uuid,integer,timestamp with time zone)') IS NULL
    OR to_regclass('hon.attendance_records') IS NULL OR to_regclass('hon.memberships') IS NULL THEN
    RAISE EXCEPTION '0475 requires 0423, 0177 and 0032'; END IF;
END $$;

-- One receipt per workflow and school-local date it was scanned on.
CREATE TABLE hon.automation_schedule_scans (
  workflow_id uuid NOT NULL,
  local_date date NOT NULL,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('ABSENT_DAYS','BIRTHDAY','MEMBERSHIP_ENDS_IN_DAYS')),
  runs_started integer NOT NULL CHECK (runs_started BETWEEN 0 AND 1000),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,40}$'),
  scanned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id,local_date),
  FOREIGN KEY (workflow_id,organization_id,school_id) REFERENCES hon.automation_workflows(id,organization_id,school_id)
);
CREATE INDEX automation_schedule_scans_school_idx ON hon.automation_schedule_scans (organization_id,school_id,scanned_at DESC);
ALTER TABLE hon.automation_schedule_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.automation_schedule_scans FORCE ROW LEVEL SECURITY;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.automation_schedule_scans FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_workflow_history();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.automation_schedule_scans FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_automation_workflow_history();

-- 0423 body, with the three date triggers now runnable.
CREATE OR REPLACE FUNCTION hon.automation_unavailable(d jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE s jsonb; c jsonb; t text; m text;
BEGIN
  IF NOT (d->'trigger'->>'kind' = ANY (ARRAY['LEAD_CREATED','FORM_LEAD_RECEIVED','META_LEAD_RECEIVED','TRIAL_BOOKED','TRIAL_CANCELLED','TRIAL_ATTENDED',
      'TRIAL_NO_SHOW','CLASS_BOOKING_CREATED','MEMBERSHIP_ACTIVATED','MEMBERSHIP_CANCELLED','TESTING_REGISTRATION_SUBMITTED','TAG_ADDED',
      'ABSENT_DAYS','BIRTHDAY','MEMBERSHIP_ENDS_IN_DAYS'])) THEN
    RETURN 'trigger '||(d->'trigger'->>'kind'); END IF;
  IF d->'exitWhen' ? 'REPLIED' THEN RETURN 'exit REPLIED'; END IF;
  FOR c IN SELECT x FROM jsonb_array_elements(d->'entry'->'conditions') x UNION ALL
    SELECT y->'condition' FROM jsonb_array_elements(d->'steps') y WHERE y->>'type'='IF' LOOP
    IF c->>'kind' IN ('REPLIED','IN_PROGRAM','CUSTOM_FIELD_EQUALS') THEN RETURN 'condition '||(c->>'kind'); END IF;
  END LOOP;
  FOR s IN SELECT x FROM jsonb_array_elements(d->'steps') x LOOP
    IF s->>'type' IN ('ASSIGN_LEAD','REQUEST_APPROVAL') THEN RETURN 'step '||(s->>'type'); END IF;
    IF s->>'type'='WAIT_FOR' AND s->>'event'='REPLIED' THEN RETURN 'wait for REPLIED'; END IF;
    IF s->>'type' IN ('CREATE_TASK','NOTIFY_STAFF') AND coalesce(s->>'assignTo',s->>'to')='LEAD_ASSIGNEE' THEN RETURN 'staff target LEAD_ASSIGNEE'; END IF;
    FOREACH t IN ARRAY ARRAY[s->'content'->>'text',s->'content'->>'subject',s->'content'->>'fallbackText',s->'content'->>'fallbackSubject',s->>'title',s->>'details',s->>'text'] LOOP
      IF t IS NOT NULL THEN
        m:=substring(t from '\{\{(program_name|trial_time|booking_link|staff_name)\}\}');
        IF m IS NOT NULL THEN RETURN 'merge field '||m; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

-- The first birthday on or after p_today; 29 February is kept on 28 February in other years.
CREATE FUNCTION hon.automation_next_birthday(p_birth date,p_today date) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE y integer; mm integer; dd integer; o date;
BEGIN
  IF p_birth IS NULL OR p_today IS NULL THEN RETURN NULL; END IF;
  mm:=extract(month FROM p_birth)::integer;
  FOR y IN extract(year FROM p_today)::integer .. extract(year FROM p_today)::integer+1 LOOP
    dd:=extract(day FROM p_birth)::integer;
    IF mm=2 AND dd=29 AND NOT ((y%4=0 AND y%100<>0) OR y%400=0) THEN dd:=28; END IF;
    o:=make_date(y,mm,dd);
    IF o>=p_today THEN RETURN o; END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- The contacts one date-triggered workflow qualifies today, with the key that keeps one run per subject. At most 1000.
CREATE FUNCTION hon.automation_date_candidates(w hon.automation_workflows,d jsonb,p_today date,p_zone text)
RETURNS TABLE(person_id uuid,trigger_key text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE n integer;
BEGIN
  CASE d->'trigger'->>'kind'
    WHEN 'ABSENT_DAYS' THEN
      n:=(d->'trigger'->'config'->>'days')::integer;
      RETURN QUERY
      SELECT m.participant_person_id,'abs:'||coalesce(la.id,m.id)::text FROM (
          SELECT DISTINCT ON (x.participant_person_id) x.* FROM hon.memberships x
          WHERE x.organization_id=w.organization_id AND x.school_id=w.school_id AND x.state='ACTIVE'
          ORDER BY x.participant_person_id,x.term_started_at NULLS LAST,x.id) m
        JOIN hon.student_profiles sp ON sp.person_id=m.participant_person_id AND sp.organization_id=m.organization_id AND sp.school_id=m.school_id
          AND sp.status='ACTIVE'
        LEFT JOIN LATERAL (SELECT a.id,a.recorded_at FROM hon.attendance_records a WHERE a.organization_id=sp.organization_id AND a.school_id=sp.school_id
          AND a.student_profile_id=sp.id AND a.status IN ('PRESENT','LATE','MAKEUP') ORDER BY a.recorded_at DESC,a.id DESC LIMIT 1) la ON true
      WHERE coalesce(la.recorded_at,m.term_started_at,m.created_at)<=clock_timestamp()-make_interval(days=>n)
      ORDER BY m.participant_person_id LIMIT 1000;
    WHEN 'BIRTHDAY' THEN
      n:=(d->'trigger'->'config'->>'daysBefore')::integer;
      RETURN QUERY
      SELECT sp.person_id,'bday:'||md5(sp.person_id::text||':'||extract(year FROM b.next_on)::integer::text)::uuid::text
      FROM hon.student_profiles sp CROSS JOIN LATERAL (SELECT hon.automation_next_birthday(sp.birth_date,p_today) next_on) b
      WHERE sp.organization_id=w.organization_id AND sp.school_id=w.school_id AND sp.status='ACTIVE' AND sp.birth_date IS NOT NULL
        AND b.next_on<=p_today+n
      ORDER BY sp.person_id LIMIT 1000;
    WHEN 'MEMBERSHIP_ENDS_IN_DAYS' THEN
      n:=(d->'trigger'->'config'->>'days')::integer;
      RETURN QUERY
      SELECT m.participant_person_id,'mend:'||md5(m.id::text||':'||extract(epoch FROM m.term_ends_at)::text)::uuid::text
      FROM hon.memberships m
      WHERE m.organization_id=w.organization_id AND m.school_id=w.school_id AND m.state='ACTIVE'
        AND m.term_ends_at>clock_timestamp() AND (m.term_ends_at AT TIME ZONE p_zone)::date<=p_today+n
      ORDER BY m.participant_person_id,m.term_ends_at,m.id LIMIT 1000;
    ELSE RAISE EXCEPTION 'AUTOMATION_TRIGGER_UNAVAILABLE' USING ERRCODE='22023';
  END CASE;
END $$;

-- Engine: scan up to p_limit date-triggered workflows that have not been scanned on their school's local date and whose
-- school has reached 09:00 local time; start the runs they qualify for. Returns counts only.
CREATE FUNCTION hon.scan_automation_schedules(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c record; w hon.automation_workflows%ROWTYPE; d jsonb; k record; started integer; scanned integer:=0; total integer:=0; failed integer:=0; paused integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'AUTOMATION_INVALID' USING ERRCODE='22023'; END IF;
  FOR c IN SELECT aw.id,s.timezone zone,(clock_timestamp() AT TIME ZONE s.timezone)::date today FROM hon.automation_workflows aw
      JOIN hon.automation_workflow_versions v ON v.workflow_id=aw.id AND v.version=aw.active_version
      JOIN hon.schools s ON s.id=aw.school_id AND s.organization_id=aw.organization_id
    WHERE aw.status='ACTIVE' AND v.definition->'trigger'->>'kind' IN ('ABSENT_DAYS','BIRTHDAY','MEMBERSHIP_ENDS_IN_DAYS')
      AND s.timezone IN (SELECT name FROM pg_timezone_names)
      AND (clock_timestamp() AT TIME ZONE s.timezone)::time>=time '09:00'
      AND NOT EXISTS(SELECT 1 FROM hon.automation_schedule_scans r WHERE r.workflow_id=aw.id AND r.local_date=(clock_timestamp() AT TIME ZONE s.timezone)::date)
    ORDER BY aw.activated_at,aw.id LIMIT p_limit LOOP
    -- Staff commands lock the workflow first; a workflow someone is changing is left for the next scan.
    SELECT * INTO w FROM hon.automation_workflows x WHERE x.id=c.id FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN w.id IS NULL OR w.status<>'ACTIVE';
    CONTINUE WHEN EXISTS(SELECT 1 FROM hon.automation_schedule_scans r WHERE r.workflow_id=w.id AND r.local_date=c.today);
    -- No run starts for a workflow whose activator no longer may run it; it is paused instead.
    IF NOT hon.automation_activator_ok(w.activated_by_principal_id,w.organization_id,w.school_id) THEN
      PERFORM hon.automation_engine_pause(w.id,'AUTHORITY_LOST'); paused:=paused+1; CONTINUE; END IF;
    SELECT v.definition INTO d FROM hon.automation_workflow_versions v WHERE v.workflow_id=w.id AND v.version=w.active_version;
    scanned:=scanned+1; started:=0;
    -- Each workflow in its own subtransaction: a scan that fails is receipted by name and keeps none of its runs.
    BEGIN
      FOR k IN SELECT * FROM hon.automation_date_candidates(w,d,c.today,c.zone) LOOP
        IF hon.automation_start_run(w,k.person_id,k.trigger_key,NULL,NULL,0,clock_timestamp()) IS NOT NULL THEN started:=started+1; END IF;
      END LOOP;
      INSERT INTO hon.automation_schedule_scans(workflow_id,local_date,organization_id,school_id,trigger_kind,runs_started)
        VALUES(w.id,c.today,w.organization_id,w.school_id,d->'trigger'->>'kind',started);
      total:=total+started;
    EXCEPTION WHEN serialization_failure OR deadlock_detected OR lock_not_available OR query_canceled THEN RAISE;
      WHEN OTHERS THEN
        INSERT INTO hon.automation_schedule_scans(workflow_id,local_date,organization_id,school_id,trigger_kind,runs_started,failure_code)
          VALUES(w.id,c.today,w.organization_id,w.school_id,d->'trigger'->>'kind',0,'SCAN_ERROR');
        failed:=failed+1;
    END;
    w:=NULL;
  END LOOP;
  RETURN jsonb_build_object('scanned',scanned,'runsStarted',total,'failed',failed,'paused',paused);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------------------------
DO $$ DECLARE f regprocedure; r record; BEGIN
  REVOKE ALL ON TABLE hon.automation_schedule_scans FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_automation_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.automation_schedule_scans FROM %I',r.rolname);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN (
    'automation_unavailable','automation_next_birthday','automation_date_candidates','scan_automation_schedules') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_automation_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r.rolname);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_automation_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.scan_automation_schedules(integer) TO hon_automation_worker;
  END IF;
END $$;

COMMIT;
