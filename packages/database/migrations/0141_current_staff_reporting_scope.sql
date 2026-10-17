BEGIN;

-- A fixed dashboard default, never a directory or a substitute for the report's
-- live authorization. Preserve FORCE RLS and all existing runtime table grants.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
      AND rolname NOT IN ('hon_runtime', 'anon', 'authenticated', 'service_role')
  ) THEN
    RAISE EXCEPTION 'Staff reporting scope requires a trusted migration owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
  ) THEN
    RAISE EXCEPTION 'Staff reporting scope requires a restricted non-bypass runtime role';
  END IF;
END;
$$;

CREATE FUNCTION hon.resolve_current_staff_reporting_scope(p_subject text)
RETURNS TABLE (organization_id uuid, school_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  WITH live_identity AS MATERIALIZED (
    SELECT principal.id AS principal_id
    FROM hon.users AS app_user
    JOIN hon.principals AS principal ON principal.user_id = app_user.id
    WHERE app_user.external_subject = p_subject
      AND principal.principal_type = 'HUMAN_USER' AND principal.is_active
      -- users has no separate activation flag; a live user is its unique active
      -- human principal. Reject any additional active principal, not just staff.
      AND (SELECT count(*) FROM hon.principals AS other
           WHERE other.user_id = app_user.id AND other.is_active) = 1
      -- Match 0077: any HQ grant excludes an ordinary-staff default, even expired.
      AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq
                      WHERE hq.principal_id = principal.id)
      AND NOT EXISTS (
        SELECT 1 FROM hon.family_access_grants AS family
        WHERE family.principal_id = principal.id AND family.effective_from <= statement_timestamp()
          AND (family.effective_until IS NULL OR family.effective_until > statement_timestamp())
      )
      -- A mixed role at ANY school is disqualifying, even without reporting.view.
      AND NOT EXISTS (
        SELECT 1 FROM hon.principal_role_grants AS mixed
        JOIN hon.roles AS mixed_role ON mixed_role.id = mixed.role_id
          AND mixed_role.organization_id = mixed.organization_id
        WHERE mixed.principal_id = principal.id AND mixed.revoked_at IS NULL
          AND mixed.effective_from <= statement_timestamp()
          AND (mixed.effective_until IS NULL OR mixed.effective_until > statement_timestamp())
          AND mixed_role.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
      )
  ), current_scopes AS MATERIALIZED (
    SELECT DISTINCT identity.principal_id, role_grant.organization_id, role_grant.school_id
    FROM live_identity AS identity
    JOIN hon.principal_role_grants AS role_grant ON role_grant.principal_id = identity.principal_id
    JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
    JOIN hon.schools AS school ON school.id = role_grant.school_id
      AND school.organization_id = role_grant.organization_id AND school.status = 'ACTIVE'
    JOIN hon.organizations AS organization ON organization.id = school.organization_id AND organization.status = 'ACTIVE'
    WHERE role_grant.revoked_at IS NULL AND role_grant.effective_from <= statement_timestamp()
      AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
      AND (role.management_school_id IS NULL OR role.management_school_id = school.id)
      AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
  ), candidates AS MATERIALIZED (
    SELECT scope.organization_id, scope.school_id
    FROM current_scopes AS scope
    -- Conservative exact-one live school, including a second non-reporting scope.
    WHERE (SELECT count(*) FROM current_scopes) = 1
      AND hon.staff_member_eligible(scope.principal_id, scope.organization_id, scope.school_id)
      AND EXISTS (
        SELECT 1 FROM hon.principal_role_grants AS role_grant
        JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
        JOIN hon.role_permissions AS role_permission ON role_permission.role_id = role.id
          AND role_permission.organization_id = role.organization_id
        JOIN hon.permissions AS permission ON permission.code = role_permission.permission_code
        WHERE role_grant.principal_id = scope.principal_id
          AND role_grant.organization_id = scope.organization_id AND role_grant.school_id = scope.school_id
          AND role_grant.revoked_at IS NULL AND role_grant.effective_from <= statement_timestamp()
          AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
          AND (role.management_school_id IS NULL OR role.management_school_id = scope.school_id)
          AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
          AND permission.code = 'reporting.view' AND permission.is_staff_assignable
      )
  )
  SELECT candidates.organization_id, candidates.school_id FROM candidates
  WHERE (SELECT count(*) FROM candidates) = 1;
$$;

REVOKE ALL ON FUNCTION hon.resolve_current_staff_reporting_scope(text) FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
  FOR client_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_current_staff_reporting_scope(text) FROM %I', client_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_current_staff_reporting_scope(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
