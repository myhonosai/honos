BEGIN;
-- Read-only qualification projections must not acquire row locks.
CREATE OR REPLACE FUNCTION hon.lock_instructor_qualification_actor(p_subject text,p_permission text,p_writing boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF p_writing THEN
  PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 ELSE
  PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE';
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE';
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUCTOR_QUALIFICATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_instructor_qualification_actor(p_subject,p_permission);
 IF p_writing THEN
  PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR SHARE;
  PERFORM 1 FROM hon.principals WHERE id=actor FOR SHARE;
  PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
  PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org ORDER BY effective_from, tier FOR SHARE;
 END IF;
 RETURN hon.require_instructor_qualification_actor(p_subject,p_permission);
END $$;

COMMIT;
