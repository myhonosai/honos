BEGIN;

-- Staff invitation role discovery (provisional number 0207; the owner allocates the final number).
-- The staff invitation screen needs the roles the signed-in staff manager may actually invite someone into.
-- One read-only, exact-school function returns exactly the roles 0204's school_staff_role_grantable accepts for
-- this manager: organization roles usable at this school, never system/OWNER/HQ/platform, every permission
-- staff-assignable and currently held by the manager. It reuses 0204's manager predicate (iam.staff_role.manage +
-- iam.staff_role.grant at this school, active human principal, live paid access), checked before and again after
-- the read. No write, no lock, no table access for runtime; at most 100 roles, ordered by name then id, with an
-- explicit truncated flag. It discloses nothing the manager could not already grant.

CREATE FUNCTION hon.read_school_staff_invitation_roles(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_org uuid; result jsonb;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  actor:=hon.school_staff_manager(p_subject,p_school);
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT s.organization_id INTO v_org FROM hon.schools s WHERE s.id=p_school;
  SELECT jsonb_build_object(
      'roles',coalesce(jsonb_agg(jsonb_build_object('roleId',g.id,'roleName',g.name,
        'permissionCodes',(SELECT jsonb_agg(rp.permission_code ORDER BY rp.permission_code) FROM hon.role_permissions rp WHERE rp.role_id=g.id))
        ORDER BY g.name,g.id) FILTER (WHERE g.n<=100),'[]'::jsonb),
      'truncated',count(*)>100)
    INTO result
    FROM (SELECT r.id,r.name,row_number() OVER (ORDER BY r.name,r.id) n FROM hon.roles r
          WHERE r.organization_id=v_org AND hon.school_staff_role_grantable(actor,v_org,p_school,r.id)) g;
  IF hon.school_staff_manager(p_subject,p_school) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_school_staff_invitation_roles(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.read_school_staff_invitation_roles(text,uuid) FROM '||quote_ident(r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_staff_invitation_roles(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
