BEGIN;

-- A sensitive command may wait on the organization serialization lock. Its
-- permission checks must not inherit the pre-wait statement/transaction clock.
-- This fixed predicate is VOLATILE intentionally; it consults a fresh live clock
-- after locks and respects explicit revocation and active organization/school.
CREATE OR REPLACE FUNCTION hon.principal_has_school_permission(
  p_principal_id uuid,p_organization_id uuid,p_school_id uuid,p_permission_code text
) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principals principal
    JOIN hon.principal_role_grants role_grant ON role_grant.principal_id=principal.id
    JOIN hon.role_permissions permission ON permission.role_id=role_grant.role_id AND permission.organization_id=p_organization_id
    JOIN hon.schools school ON school.id=role_grant.school_id AND school.organization_id=role_grant.organization_id
    JOIN hon.organizations organization ON organization.id=school.organization_id
    WHERE principal.id=p_principal_id AND principal.is_active
      AND role_grant.organization_id=p_organization_id AND role_grant.school_id=p_school_id
      AND school.status='ACTIVE' AND organization.status='ACTIVE' AND role_grant.revoked_at IS NULL
      AND role_grant.effective_from<=clock_timestamp()
      AND (role_grant.effective_until IS NULL OR role_grant.effective_until>clock_timestamp())
      AND permission.permission_code=p_permission_code)
$$;
REVOKE ALL ON FUNCTION hon.principal_has_school_permission(uuid,uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.principal_has_school_permission(uuid,uuid,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
