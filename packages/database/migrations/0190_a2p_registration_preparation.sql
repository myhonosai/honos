BEGIN;

-- A2P-1 is READ ONLY preparation. No assessment/consent/approval/provider/audit/outbox state is created.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
   AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
   RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
VALUES('communication.a2p.prepare','Prepare school-scoped A2P website reviews and registration drafts; no submission, consent or sending authority',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT id,organization_id,'communication.a2p.prepare' FROM hon.roles WHERE is_system_role AND code='OWNER'
ON CONFLICT DO NOTHING;

-- Fixed minimal projection; uses the same reviewed live human/school/window boundary as 0147/0175.
-- No mutation, record locks, dynamic SQL, website fetch or provider call.
CREATE FUNCTION hon.read_a2p_preparation_scope(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE org uuid; school uuid; principal uuid; actor uuid; school_name text;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject', true)
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'A2P_PREPARATION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    org := hon.current_organization_id();
    school := hon.current_school_id();
    principal := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'A2P_PREPARATION_FORBIDDEN' USING ERRCODE = '42501';
  END;
  IF org::text IS DISTINCT FROM current_setting('app.hon_organization_id', true)
    OR school::text IS DISTINCT FROM current_setting('app.hon_school_id', true) THEN
    RAISE EXCEPTION 'A2P_PREPARATION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT p.id, (SELECT name FROM hon.schools WHERE id=school AND organization_id=org) INTO actor, school_name
  FROM hon.users AS u
  JOIN hon.principals AS p ON p.user_id = u.id
  WHERE u.external_subject = p_subject
    AND p.id = principal AND p.principal_type = 'HUMAN_USER' AND p.is_active
    AND hon.staff_member_eligible(p.id,org,school)
    -- Reject a nonhuman or any other active principal for this user.
    AND (SELECT count(*) FROM hon.principals AS other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.organizations AS organization WHERE organization.id = org AND organization.status = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM hon.schools AS current_school
      WHERE current_school.id = school AND current_school.organization_id = org AND current_school.status = 'ACTIVE')
    -- This is never an HQ, family/delegated, parent, student or mixed context.
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants AS family WHERE family.principal_id = p.id
      AND family.effective_from <= clock_timestamp() AND (family.effective_until IS NULL OR family.effective_until > clock_timestamp()))
    AND NOT EXISTS (
      SELECT 1 FROM hon.principal_role_grants AS mixed
      JOIN hon.roles AS mixed_role ON mixed_role.id = mixed.role_id AND mixed_role.organization_id = mixed.organization_id
      WHERE mixed.principal_id = p.id AND mixed.revoked_at IS NULL
        AND mixed.effective_from <= clock_timestamp() AND (mixed.effective_until IS NULL OR mixed.effective_until > clock_timestamp())
        AND mixed_role.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
    )
    AND EXISTS (
      SELECT 1 FROM hon.principal_role_grants AS role_grant
      JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
      JOIN hon.role_permissions AS role_permission ON role_permission.role_id = role.id AND role_permission.organization_id = role.organization_id
      JOIN hon.permissions AS permission ON permission.code = role_permission.permission_code
      WHERE role_grant.principal_id = p.id AND role_grant.organization_id = org AND role_grant.school_id = school
        AND role_grant.revoked_at IS NULL AND role_grant.effective_from <= clock_timestamp()
        AND (role_grant.effective_until IS NULL OR role_grant.effective_until > clock_timestamp())
        AND (role.management_school_id IS NULL OR role.management_school_id = school)
        AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND permission.code = 'communication.a2p.prepare' AND permission.is_staff_assignable
    )
    AND EXISTS (
      SELECT 1 FROM hon.organization_entitlements AS entitlement
      WHERE entitlement.organization_id = org AND entitlement.status = 'ACTIVE'
        AND entitlement.tier IN ('ESSENTIAL','CORE','COMPLETE')
        AND entitlement.effective_from <= clock_timestamp()
        AND (entitlement.effective_until IS NULL OR entitlement.effective_until > clock_timestamp())
    );
  IF actor IS NULL THEN RAISE EXCEPTION 'A2P_PREPARATION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('organizationId',org,'schoolId',school,'principalId',actor,'schoolName',school_name,'canConfirmOwnerFacts',EXISTS(
    SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
    WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
      AND r.code='OWNER' AND (r.management_school_id IS NULL OR r.management_school_id=school)));
END $$;

REVOKE ALL ON FUNCTION hon.read_a2p_preparation_scope(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['hon_runtime','anon','authenticated','service_role','hon_outbox_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION hon.read_a2p_preparation_scope(text) FROM %I',r);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_a2p_preparation_scope(text) TO hon_runtime;
 END IF;
END $$;
COMMIT;
