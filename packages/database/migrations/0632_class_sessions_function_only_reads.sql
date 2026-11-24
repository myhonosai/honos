BEGIN;

-- 0632 Class sessions function-only reads (coordinator-allocated 2026-11-22; launch-readiness review P2 "canonical
-- privilege", issue #177, docs/architecture/CLASS_SESSIONS_FUNCTION_ONLY_READS.md).
-- Owner decision (David, 2026-11-22, decision card on #177): "Lock it down". 0147 made the named projection the only
-- class-session read for the runtime, but the canonical grants (infra/postgres/010) still gave hon_runtime direct SELECT
-- on hon.class_sessions, and two services depended on it. Forced RLS kept reads in the tenant, so this was a
-- posture/proof mismatch, not a leak.
--   CS1  hon.read_operations_report_session_counts(subject, from, to): the operations report's class-session and
--        attendance counts for the current school, only for the transaction's own human principal holding
--        reporting.view there (hon.resolve_authorized_scope, the same check the report controller makes).
--   CS2  hon.read_parent_family_schedule(subject, family, from, to): the exact parent schedule projection the API built
--        in SQL, only for the transaction's own principal when hon.resolve_parent_family_scope returns that family at
--        the current school.
--   CS3  Both refuse a missing tenant context or principal, a non-HUMAN_USER principal type, and an action-request or
--        delegated command with 42501 before reading; the subject must resolve to the transaction's own principal.
--        Both return nothing but the fields the services already returned.
--   CS4  The runtime's direct SELECT on hon.class_sessions is revoked here and no longer granted by 010; it keeps INSERT
--        (class creation, which no longer uses RETURNING) and gains EXECUTE on these two functions only.
-- Nothing here changes data, sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.resolve_authorized_scope(text,uuid,text)') IS NULL OR to_regprocedure('hon.resolve_parent_family_scope(text,uuid)') IS NULL
    OR to_regprocedure('hon.read_current_school_class_sessions(text)') IS NULL THEN
    RAISE EXCEPTION '0632 requires 0059, 0147 and 0473'; END IF;
END $$;

CREATE FUNCTION hon.require_class_sessions_human_read() RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF nullif(current_setting('app.hon_organization_id',true),'') IS NULL OR nullif(current_setting('app.hon_school_id',true),'') IS NULL
    OR nullif(current_setting('app.hon_principal_id',true),'') IS NULL
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION hon.read_operations_report_session_counts(p_subject text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(sessions_scheduled bigint,sessions_completed bigint,sessions_cancelled bigint,attendance_present bigint,
  attendance_late bigint,attendance_excused_absence bigint,attendance_unexcused_absence bigint,attendance_makeup bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid;
BEGIN
  PERFORM hon.require_class_sessions_human_read();
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  IF p_subject IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
    OR NOT EXISTS(SELECT 1 FROM hon.resolve_authorized_scope(p_subject,school,'reporting.view') a
      WHERE a.principal_id::text=current_setting('app.hon_principal_id',true) AND a.organization_id=org AND a.school_id=school) THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  WITH ranged AS MATERIALIZED (
    SELECT s.id,s.status::text AS status FROM hon.class_sessions s
    WHERE s.organization_id=org AND s.school_id=school AND s.starts_at>=p_from AND s.starts_at<p_to),
  attendance AS MATERIALIZED (
    SELECT a.status::text AS status FROM hon.attendance_records a JOIN ranged r ON r.id=a.class_session_id
    WHERE a.organization_id=org AND a.school_id=school)
  SELECT (SELECT count(*) FILTER (WHERE status='SCHEDULED') FROM ranged),(SELECT count(*) FILTER (WHERE status='COMPLETED') FROM ranged),
    (SELECT count(*) FILTER (WHERE status='CANCELLED') FROM ranged),(SELECT count(*) FILTER (WHERE status='PRESENT') FROM attendance),
    (SELECT count(*) FILTER (WHERE status='LATE') FROM attendance),(SELECT count(*) FILTER (WHERE status='EXCUSED_ABSENCE') FROM attendance),
    (SELECT count(*) FILTER (WHERE status='UNEXCUSED_ABSENCE') FROM attendance),(SELECT count(*) FILTER (WHERE status='MAKEUP') FROM attendance);
END $$;

CREATE FUNCTION hon.read_parent_family_schedule(p_subject text,p_family uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(student_display_name text,booking_kind text,booking_status text,session_name text,session_starts_at timestamptz,
  session_ends_at timestamptz,session_room_name text,session_status text,program_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid;
BEGIN
  PERFORM hon.require_class_sessions_human_read();
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  IF p_subject IS NULL OR p_family IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
    OR NOT EXISTS(SELECT 1 FROM hon.resolve_parent_family_scope(p_subject,school) f
      WHERE f.family_id=p_family AND f.principal_id::text=current_setting('app.hon_principal_id',true)
        AND f.organization_id=org AND f.school_id=school) THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- The relation path is the one the API used: exact-family STUDENT membership -> its primary-family profile ->
  -- booking -> session -> program, with the family repeated at the profile and membership links.
  RETURN QUERY
  SELECT concat_ws(' ',person.given_name,person.family_name)::text,booking.booking_kind::text,booking.status::text,
    session.name::text,session.starts_at,session.ends_at,session.room_name::text,session.status::text,program.name::text
  FROM hon.family_members member
  JOIN hon.student_profiles profile ON profile.person_id=member.person_id AND profile.organization_id=member.organization_id
    AND profile.school_id=member.school_id AND profile.primary_family_id=member.family_id AND profile.primary_family_id=p_family
  JOIN hon.class_bookings booking ON booking.student_profile_id=profile.id AND booking.organization_id=profile.organization_id
    AND booking.school_id=profile.school_id
  JOIN hon.class_sessions session ON session.id=booking.class_session_id AND session.organization_id=booking.organization_id
    AND session.school_id=booking.school_id
  JOIN hon.programs program ON program.id=session.program_id AND program.organization_id=session.organization_id
    AND program.school_id=session.school_id
  JOIN hon.people person ON person.id=member.person_id AND person.organization_id=member.organization_id AND person.school_id=member.school_id
  WHERE member.organization_id=org AND member.school_id=school AND member.family_id=p_family
    AND member.member_role='STUDENT'::hon.family_member_role AND session.starts_at>=p_from AND session.starts_at<p_to
  ORDER BY session.starts_at,session.id,booking.id;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.require_class_sessions_human_read()','hon.read_operations_report_session_counts(text,timestamptz,timestamptz)',
    'hon.read_parent_family_schedule(text,uuid,timestamptz,timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE SELECT ON TABLE hon.class_sessions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE SELECT ON TABLE hon.class_sessions FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_operations_report_session_counts(text,timestamptz,timestamptz),
      hon.read_parent_family_schedule(text,uuid,timestamptz,timestamptz) TO hon_runtime;
  END IF;
END $$;
COMMIT;
