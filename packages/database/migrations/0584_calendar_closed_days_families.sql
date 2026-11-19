BEGIN;

-- 0584 closed days for families (owner David 2026-11-19 decision "Hide from families only", number assigned by the
-- coordinator; was 0575): a class whose school-local start date is inside an ACTIVE block-out (0583) of its own school is no longer
-- offered to families. Staff keep the 0583 behaviour: the calendar marks the day closed and asks before adding or moving a
-- class there, and staff booking, ClassPass, owner-launch and every other staff path are unchanged.
--   C1  hon.class_session_on_closed_day(hon.class_sessions): private helper; the session's own school and its school time zone.
--   C2  hon.parent_class_booking_session_ok (0329): parent app choices leave such classes out and booking one is refused
--       (PARENT_CLASS_BOOKING_NOT_OFFERED, nothing written). Existing bookings and their cancellation are unchanged.
--   C3  hon.walkin_trial_session_open and hon.walkin_trial_classes (0538): the kiosk tablet does not list such trial classes and
--       a submit naming one is refused like an unavailable class (CLASS_FULL, nothing written).
-- The public shared calendar already hides block-out days (0583 share_calendar_times). Signatures are unchanged, so every ACL
-- stays as it was; the new helper is migration-owner only. No message, charge, CRM lead, booking change or AI.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Closed days for families require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.calendar_day_blocked(uuid,uuid,date)') IS NULL
    OR to_regprocedure('hon.parent_class_booking_session_ok(uuid,hon.class_sessions)') IS NULL
    OR to_regprocedure('hon.walkin_trial_session_open(hon.class_sessions,jsonb,integer)') IS NULL
    OR to_regprocedure('hon.walkin_trial_classes(uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations 0329, 0538 and 0583 first';
  END IF;
END $$;

-- C1
CREATE FUNCTION hon.class_session_on_closed_day(s hon.class_sessions) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT hon.calendar_day_blocked(s.organization_id,s.school_id,(s.starts_at AT TIME ZONE sc.timezone)::date)
    FROM hon.schools sc WHERE sc.id=s.school_id AND sc.organization_id=s.organization_id),false)
$$;

-- C2 (0329 body plus the closed-day rule)
CREATE OR REPLACE FUNCTION hon.parent_class_booking_session_ok(child uuid, s hon.class_sessions) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT s.id IS NOT NULL AND s.status='SCHEDULED' AND s.booking_policy IN ('OPTIONAL_BOOKING','REQUIRED_BOOKING')
    AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id()
    AND s.starts_at>clock_timestamp() AND s.starts_at<clock_timestamp()+interval '14 days'
    AND EXISTS(SELECT 1 FROM hon.student_curriculum_enrollments e WHERE e.student_profile_id=child AND e.status='ACTIVE'
      AND e.program_id=s.program_id AND e.organization_id=s.organization_id AND e.school_id=s.school_id)
    AND NOT hon.class_session_on_closed_day(s);
$$;

-- C3 (0538 bodies plus the closed-day rule)
CREATE OR REPLACE FUNCTION hon.walkin_trial_session_open(s hon.class_sessions,program_ids jsonb,seats integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT s.id IS NOT NULL AND s.status='SCHEDULED' AND s.starts_at>clock_timestamp() AND s.starts_at<=clock_timestamp()+interval '14 days'
    AND seats>=1 AND jsonb_typeof(program_ids)='array' AND program_ids ? s.program_id::text
    AND EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=s.program_id AND g.organization_id=s.organization_id AND g.school_id=s.school_id AND g.status<>'CANCELLED'
      AND NOT hon.demo_data_is_demo('programs',g.id))
    AND NOT hon.demo_data_is_demo('class_sessions',s.id)
    AND NOT hon.class_session_on_closed_day(s)
    AND s.capacity-hon.walkin_session_taken(s.id)>=seats
$$;
CREATE OR REPLACE FUNCTION hon.walkin_trial_classes(org uuid,school uuid,program_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',c.id,'name',c.name,'startsAt',hon.walkin_utc(c.starts_at),'endsAt',hon.walkin_utc(c.ends_at),
      'spotsOpen',greatest(c.capacity-hon.walkin_session_taken(c.id),0)) ORDER BY c.starts_at,c.id),'[]'::jsonb)
  FROM (SELECT s.* FROM hon.class_sessions s JOIN hon.programs g ON g.id=s.program_id AND g.organization_id=s.organization_id AND g.school_id=s.school_id
    WHERE s.organization_id=org AND s.school_id=school AND s.status='SCHEDULED' AND g.status<>'CANCELLED'
      AND NOT hon.demo_data_is_demo('programs',g.id) AND NOT hon.demo_data_is_demo('class_sessions',s.id)
      AND s.starts_at>clock_timestamp() AND s.starts_at<=clock_timestamp()+interval '14 days'
      AND jsonb_typeof(program_ids)='array' AND program_ids ? s.program_id::text
      AND NOT hon.class_session_on_closed_day(s)
    ORDER BY s.starts_at,s.id LIMIT 20) c
$$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.class_session_on_closed_day(hon.class_sessions) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.class_session_on_closed_day(hon.class_sessions) FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') AND (
    has_function_privilege('hon_runtime','hon.class_session_on_closed_day(hon.class_sessions)','EXECUTE')
    OR has_function_privilege('hon_runtime','hon.parent_class_booking_session_ok(uuid,hon.class_sessions)','EXECUTE')
    OR has_function_privilege('hon_runtime','hon.walkin_trial_session_open(hon.class_sessions,jsonb,integer)','EXECUTE')
    OR has_function_privilege('hon_runtime','hon.walkin_trial_classes(uuid,uuid,jsonb)','EXECUTE')) THEN
    RAISE EXCEPTION 'Closed days for families must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
