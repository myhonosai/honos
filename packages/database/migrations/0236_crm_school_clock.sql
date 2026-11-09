BEGIN;

-- B-CRM-3 school-time entry for CRM times (0236, assigned by the coordinator 2026-11-09 under the owner's delegation).
-- CRM trial and follow-up screens took times in UTC because the runtime cannot read hon.schools. This read returns the
-- current school's IANA timezone and its local today so a screen can take and show times in school time; every command
-- still receives an offset-qualified ISO 8601 instant, exactly as today. It writes nothing, takes no lock and returns
-- no tenant directory data: only the session school's id, timezone, local date and the read instant.
-- Authority: a direct human UI session holding, live at this exact school, one of the CRM trial or follow-up
-- permissions, while the organization has paid access in effect (fails closed like 0217). Decided against
-- clock_timestamp() before the read and again after it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.schools') IS NULL OR to_regclass('hon.organization_entitlements') IS NULL
    OR to_regprocedure('hon.current_school_id()') IS NULL OR to_regprocedure('hon.current_organization_id()') IS NULL THEN
    RAISE EXCEPTION '0236 requires the school, entitlement and session scope foundations'; END IF;
END $$;

-- Live human CRM time authority at this exact school, or NULL.
CREATE FUNCTION hon.crm_school_clock_actor(p_subject text,p_org uuid,p_school uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT p.id FROM hon.users u
  JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
  JOIN hon.schools s ON s.id=p_school AND s.organization_id=p_org AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
  WHERE u.external_subject=p_subject
    AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g
      JOIN hon.roles r ON r.id=g.role_id
      JOIN hon.role_permissions rp ON rp.role_id=g.role_id AND rp.organization_id=s.organization_id
        AND rp.permission_code IN ('crm.trial.schedule','crm.trial.manage','crm.follow_up.manage','crm.follow_up.self_manage')
      WHERE g.principal_id=p.id AND g.organization_id=s.organization_id AND g.school_id=s.id AND g.revoked_at IS NULL
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
  LIMIT 1
$$;

CREATE FUNCTION hon.read_crm_school_clock(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; tz text; at timestamptz;
BEGIN
  IF p_subject IS NULL OR org IS NULL OR school IS NULL
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_SCHOOL_CLOCK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  actor:=hon.crm_school_clock_actor(p_subject,org,school);
  IF actor IS NULL THEN RAISE EXCEPTION 'CRM_SCHOOL_CLOCK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  at:=clock_timestamp();
  -- A recheck prevents returning the read after a live access loss.
  IF hon.crm_school_clock_actor(p_subject,org,school) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CRM_SCHOOL_CLOCK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('schoolId',school,'schoolTimezone',tz,
    'localToday',to_char((at AT TIME ZONE tz)::date,'YYYY-MM-DD'),
    'asOf',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;

COMMENT ON FUNCTION hon.read_crm_school_clock(text) IS
'B-CRM-3 (0236) direct HUMAN_UI read of the session school''s IANA timezone and local date, for CRM time entry and display. Any of crm.trial.schedule/manage or crm.follow_up.manage/self_manage live at the exact school with paid access in effect, decided against clock_timestamp() before and after the read. No DML, locks, audit, outbox or idempotency.';

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.crm_school_clock_actor(text,uuid,uuid)','hon.read_crm_school_clock(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_school_clock(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
