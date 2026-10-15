BEGIN;

-- organization_entitlements is keyed by organization/tier validity rather than a surrogate id.
-- Lock the scoped entitlement rows without an invalid ordering reference.
CREATE OR REPLACE FUNCTION hon.lock_teaching_studio_actor(subject text,permission text,writing boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF writing THEN
  PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 END IF;
 actor:=hon.require_teaching_studio_actor(subject,permission);
 PERFORM 1 FROM hon.principals WHERE id=actor FOR SHARE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_teaching_studio_actor(subject,permission);
END $$;

REVOKE ALL ON FUNCTION hon.lock_teaching_studio_actor(text,text,boolean) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.lock_teaching_studio_actor(text,text,boolean) TO hon_runtime;
 END IF;
END $$;
COMMIT;
